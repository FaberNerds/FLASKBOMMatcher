"""
BOM Matcher - Match API Routes
Handles IPN finding, MPNfree assessment, manual search, and overrides.
"""
import logging
from flask import Blueprint, request, jsonify

from services.session_service import (
    get_session_id, load_bom_data, save_matches, load_matches,
    save_mpnfree, load_mpnfree,
    save_selections, load_selections,
    save_to_history
)
from services.match_service import find_ipn_batch, find_ipn_single, filter_customer_specific, keep_selected_articles
from services.previous_bom_match_service import (
    match_against_previous_bom, match_previous_single,
)
from services import search_service
from services.ai_service import assess_mpnfree_batch_local

logger = logging.getLogger(__name__)

match_bp = Blueprint('match', __name__)


def _forget_picked_parts(selections: dict, only_row: str = None) -> dict:
    """Selections without the FaberNr picked by hand (MPNfree choices stay); empty rows dropped."""
    out = {}
    for idx, sel in (selections or {}).items():
        sel = dict(sel or {})
        if only_row is None or idx == only_row:
            sel.pop('fabernr', None)
        if sel:
            out[idx] = sel
    return out


@match_bp.route('/match/find-ipn', methods=['POST'])
def find_ipn():
    """Batch find IPN for all BOM rows."""
    bom_data = load_bom_data()
    if not bom_data:
        logger.warning("find_ipn called but no BOM data loaded")
        return jsonify({'error': 'No BOM data loaded'}), 400

    rows = bom_data.get('rows', [])
    mapping = bom_data.get('column_mapping', {})

    if not rows:
        return jsonify({'error': 'BOM has no rows'}), 400

    selected_klant_nr = bom_data.get('klant_nr', '')
    previous_bom = bom_data.get('previous_bom')

    try:
        if previous_bom:
            # Previous-BOM mode: match the new BOM against the old (Exact) BOM instead
            # of the live ERP catalog, and force MPNfree to "No" for every row.
            logger.info(
                f"=== PREVIOUS-BOM MATCH START === {len(rows)} new rows vs "
                f"{len(previous_bom)} old parts (article {bom_data.get('previous_article_id', '')})"
            )
            # MPNfree is output-only in this mode (not used for matching) — leave it untouched.
            results = match_against_previous_bom(
                rows, mapping, previous_bom, selected_klant_nr=selected_klant_nr
            )
        else:
            # Build per-row mpnfree flags from session (AI + user overrides)
            mpnfree = load_mpnfree() or {}
            selections = load_selections() or {}

            mpnfree_flags = {}
            for i in range(len(rows)):
                str_idx = str(i)
                sel = selections.get(str_idx, {})
                if sel.get('mpnfree') is not None:
                    mpnfree_flags[str_idx] = sel['mpnfree']
                elif str_idx in mpnfree:
                    mpnfree_flags[str_idx] = mpnfree[str_idx].get('mpnfree', False)

            mpnfree_count = sum(1 for v in mpnfree_flags.values() if v)
            logger.info(f"=== IPN SEARCH START === {len(rows)} rows, {mpnfree_count} MPNfree, klant='{selected_klant_nr}'")
            results = find_ipn_batch(rows, mapping, mpnfree_flags=mpnfree_flags, selected_klant_nr=selected_klant_nr)

        # Convert to dict keyed by row index for storage
        matches_dict = {}
        for r in results:
            matches_dict[str(r['row_index'])] = r
        save_matches(matches_dict)

        # Find IPN starts over: the parts picked by hand before are forgotten (the MPNfree
        # choices stay, they are an input of the search). Only Find IPN's own result counts.
        selections = _forget_picked_parts(load_selections() or {})
        save_selections(selections)

        # Update history entry with match state
        session_id = get_session_id()
        save_to_history(session_id, bom_data.get('name', ''), bom_data.get('klant_nr', ''))

        # Matched = a part is linked; a suggestion alone is no match
        matched = sum(1 for r in results if r.get('auto_selected'))
        param_matched = sum(1 for r in results if r.get('search_method') == 'parameterized' and r.get('auto_selected'))
        logger.info(f"=== IPN SEARCH DONE === {matched}/{len(results)} rows matched ({param_matched} parameterized)")

        return jsonify({
            'success': True,
            'results': results,
            'selections': selections,
            'matched': matched,
            'total': len(results),
            'parameterized': param_matched
        })
    except Exception as e:
        logger.error(f"find_ipn error: {e}")
        return jsonify({'error': f'Search failed: {str(e)}'}), 500


@match_bp.route('/match/find-ipn-single', methods=['POST'])
def find_ipn_single_route():
    """Re-search a single row."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No BOM data loaded'}), 400

    data = request.get_json()
    row_index = data.get('row_index')
    if row_index is None:
        return jsonify({'error': 'row_index required'}), 400

    rows = bom_data.get('rows', [])
    mapping = bom_data.get('column_mapping', {})

    if row_index < 0 or row_index >= len(rows):
        return jsonify({'error': 'Invalid row index'}), 400

    selected_klant_nr = bom_data.get('klant_nr', '')
    previous_bom = bom_data.get('previous_bom')

    # Check mpnfree status for this row (ignored in previous-BOM mode)
    mpnfree = load_mpnfree() or {}
    selections_data = load_selections() or {}
    str_idx = str(row_index)
    sel = selections_data.get(str_idx, {})
    is_mpnfree = False
    if sel.get('mpnfree') is not None:
        is_mpnfree = sel['mpnfree']
    elif str_idx in mpnfree:
        is_mpnfree = mpnfree[str_idx].get('mpnfree', False)

    logger.info(f"Re-search row {row_index}, mpnfree={is_mpnfree}, klant='{selected_klant_nr}', previous_bom={bool(previous_bom)}")

    try:
        if previous_bom:
            result = match_previous_single(
                row_index, rows[row_index], mapping, previous_bom, selected_klant_nr=selected_klant_nr
            )
        else:
            result = find_ipn_single(row_index, rows[row_index], mapping, is_mpnfree=is_mpnfree, selected_klant_nr=selected_klant_nr)

        logger.info(f"Row {row_index} result: {result['search_method']}, {result['confidence']}, {len(result['suggestions'])} suggestions")

        # Update stored matches; as Find IPN, the row starts over (a part picked by hand is forgotten)
        matches = load_matches() or {}
        matches[str(row_index)] = result
        save_matches(matches)
        selections_data = _forget_picked_parts(selections_data, only_row=str_idx)
        save_selections(selections_data)

        return jsonify({'success': True, 'result': result, 'selection': selections_data.get(str_idx)})
    except Exception as e:
        logger.error(f"find_ipn_single error: {e}")
        return jsonify({'error': f'Search failed: {str(e)}'}), 500


@match_bp.route('/match/manual-search', methods=['POST'])
def manual_search():
    """Manual search by MPN, IPN, or description terms."""
    data = request.get_json()
    row_index = data.get('row_index')
    search_type = data.get('search_type', 'description')
    query = data.get('query', '').strip()

    if not query:
        return jsonify({'error': 'Search query required'}), 400

    logger.info(f"Manual search row {row_index}: type={search_type}, query='{query}'")

    try:
        if search_type == 'mpn':
            suggestions = search_service.search_by_mpn(query)
        elif search_type == 'ipn':
            suggestions = search_service.search_by_ipn(query)
        else:
            # Description: split into terms
            terms = query.split()
            suggestions = search_service.search_by_description(terms)

        # Filter customer-specific IPNs (7xx, 9xx, 500xx)
        bom_data = load_bom_data()
        selected_klant_nr = bom_data.get('klant_nr', '') if bom_data else ''
        suggestions = filter_customer_specific(suggestions, selected_klant_nr)

        suggestions = suggestions[:20]

        # Build a result dict compatible with matchResults
        confidence = 'low' if suggestions else 'none'
        result = {
            'row_index': row_index,
            'search_method': f'manual_{search_type}',
            'suggestions': suggestions,
            'auto_selected': suggestions[0] if suggestions else None,
            'confidence': confidence
        }

        # Update stored matches (not for a preview: the row panel only shows the results
        # and stores a match once the user picks one, through /match/set-row)
        if row_index is not None and not data.get('preview'):
            sel = (load_selections() or {}).get(str(row_index), {})
            keep_selected_articles({str(row_index): result}, {str(row_index): sel})
            matches = load_matches() or {}
            matches[str(row_index)] = result
            save_matches(matches)

        return jsonify({
            'success': True,
            'suggestions': suggestions,
            'result': result
        })
    except Exception as e:
        logger.error(f"manual_search error: {e}")
        return jsonify({'error': f'Search failed: {str(e)}'}), 500


@match_bp.route('/match/mpnfree', methods=['POST'])
def assess_mpnfree():
    """Batch MPNfree assessment using rule-based classification."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No BOM data loaded'}), 400

    rows = bom_data.get('rows', [])
    mapping = bom_data.get('column_mapping', {})

    if not rows:
        return jsonify({'error': 'BOM has no rows'}), 400

    try:
        from services.match_service import _get_mapped_value

        input_rows = []
        for i, row in enumerate(rows):
            input_rows.append({
                'index': i,
                'mpn': _get_mapped_value(row, mapping, 'MPN'),
                'manufacturer': _get_mapped_value(row, mapping, 'Manufacturer'),
                'description': _get_mapped_value(row, mapping, 'Description'),
                'refdes': _get_mapped_value(row, mapping, 'Refdes'),
            })

        results = assess_mpnfree_batch_local(input_rows)

        # Store keyed by row index
        mpnfree_dict = {}
        for r in results:
            mpnfree_dict[str(r['index'])] = r

        save_mpnfree(mpnfree_dict)

        # Update history entry with mpnfree state
        session_id = get_session_id()
        save_to_history(session_id, bom_data.get('name', ''), bom_data.get('klant_nr', ''))

        return jsonify({
            'success': True,
            'results': results,
            'mpnfree_count': sum(1 for r in results if r.get('mpnfree')),
            'total': len(results)
        })
    except Exception as e:
        logger.error(f"assess_mpnfree error: {e}")
        return jsonify({'error': f'MPNfree assessment failed: {str(e)}'}), 500


@match_bp.route('/match/mpnfree/clear', methods=['POST'])
def clear_mpnfree():
    """Clear all MPNfree data (AI assessments and user overrides)."""
    from services.session_service import _get_path
    session_id = get_session_id()

    # Delete mpnfree file
    path = _get_path(session_id, 'mpnfree')
    if path.exists():
        path.unlink()

    # Strip mpnfree keys from selections
    selections = load_selections() or {}
    changed = False
    for row_data in selections.values():
        if 'mpnfree' in row_data:
            del row_data['mpnfree']
            changed = True
    if changed:
        save_selections(selections)

    return jsonify({'success': True})


@match_bp.route('/match/delete', methods=['POST'])
def delete_match():
    """Delete match and selection for a row."""
    data = request.get_json()
    row_index = data.get('row_index')
    if row_index is None:
        return jsonify({'error': 'row_index required'}), 400

    str_idx = str(row_index)

    matches = load_matches() or {}
    if str_idx in matches:
        del matches[str_idx]
        save_matches(matches)

    sels = load_selections() or {}
    if str_idx in sels:
        del sels[str_idx]
        save_selections(sels)

    return jsonify({'success': True})


@match_bp.route('/match/set-row', methods=['POST'])
def set_row_state():
    """Replace the stored match and selection of one row as a whole.

    Used by the row panel on the match page: Remove match, Accept suggestion, Use and Undo.
    ``match`` / ``selection`` set to null remove that row's entry.
    """
    data = request.get_json(silent=True) or {}
    row_index = data.get('row_index')
    if not isinstance(row_index, int) or isinstance(row_index, bool):
        return jsonify({'error': 'row_index required'}), 400

    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No BOM data loaded'}), 400
    if row_index < 0 or row_index >= len(bom_data.get('rows', [])):
        return jsonify({'error': 'Invalid row index'}), 400

    match = data.get('match')
    selection = data.get('selection')
    if match is not None and not isinstance(match, dict):
        return jsonify({'error': 'match must be an object or null'}), 400
    if selection is not None and not isinstance(selection, dict):
        return jsonify({'error': 'selection must be an object or null'}), 400

    str_idx = str(row_index)

    matches = load_matches() or {}
    if match is None:
        matches.pop(str_idx, None)
    else:
        match['row_index'] = row_index
        matches[str_idx] = match
    save_matches(matches)

    sels = load_selections() or {}
    clean_sel = {k: selection[k] for k in ('fabernr', 'mpnfree') if selection and k in selection}
    if clean_sel:
        sels[str_idx] = clean_sel
    else:
        sels.pop(str_idx, None)
    save_selections(sels)

    return jsonify({'success': True})


@match_bp.route('/match/override', methods=['POST'])
def override_selection():
    """User overrides FaberNr or MPNfree for a row."""
    data = request.get_json()
    row_index = data.get('row_index')
    if row_index is None:
        return jsonify({'error': 'row_index required'}), 400

    selections = load_selections() or {}
    str_idx = str(row_index)

    if str_idx not in selections:
        selections[str_idx] = {}

    if 'fabernr' in data:
        selections[str_idx]['fabernr'] = data['fabernr']
    if 'mpnfree' in data:
        selections[str_idx]['mpnfree'] = data['mpnfree']

    save_selections(selections)

    return jsonify({'success': True})
