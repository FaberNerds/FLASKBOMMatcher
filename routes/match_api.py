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
from services.match_service import find_ipn_batch, find_ipn_single, filter_customer_specific
from services import search_service
from services.ai_service import assess_mpnfree_batch_local

logger = logging.getLogger(__name__)

match_bp = Blueprint('match', __name__)


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

    selected_klant_nr = bom_data.get('klant_nr', '')
    mpnfree_count = sum(1 for v in mpnfree_flags.values() if v)
    logger.info(f"=== IPN SEARCH START === {len(rows)} rows, {mpnfree_count} MPNfree, klant='{selected_klant_nr}'")

    try:
        results = find_ipn_batch(rows, mapping, mpnfree_flags=mpnfree_flags, selected_klant_nr=selected_klant_nr)

        # Convert to dict keyed by row index for storage
        matches_dict = {}
        for r in results:
            matches_dict[str(r['row_index'])] = r

        save_matches(matches_dict)

        # Update history entry with match state
        session_id = get_session_id()
        save_to_history(session_id, bom_data.get('name', ''), bom_data.get('klant_nr', ''))

        matched = sum(1 for r in results if r['confidence'] != 'none')
        param_matched = sum(1 for r in results if r.get('search_method') == 'parameterized')
        logger.info(f"=== IPN SEARCH DONE === {matched}/{len(results)} rows matched ({param_matched} parameterized)")

        return jsonify({
            'success': True,
            'results': results,
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

    # Check mpnfree status for this row
    mpnfree = load_mpnfree() or {}
    selections_data = load_selections() or {}
    str_idx = str(row_index)
    sel = selections_data.get(str_idx, {})
    is_mpnfree = False
    if sel.get('mpnfree') is not None:
        is_mpnfree = sel['mpnfree']
    elif str_idx in mpnfree:
        is_mpnfree = mpnfree[str_idx].get('mpnfree', False)

    selected_klant_nr = bom_data.get('klant_nr', '')
    logger.info(f"Re-search row {row_index}, mpnfree={is_mpnfree}, klant='{selected_klant_nr}'")

    try:
        result = find_ipn_single(row_index, rows[row_index], mapping, is_mpnfree=is_mpnfree, selected_klant_nr=selected_klant_nr)

        logger.info(f"Row {row_index} result: {result['search_method']}, {result['confidence']}, {len(result['suggestions'])} suggestions")

        # Update stored matches
        matches = load_matches() or {}
        matches[str(row_index)] = result
        save_matches(matches)

        return jsonify({'success': True, 'result': result})
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

        # Update stored matches
        if row_index is not None:
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
                'description': _get_mapped_value(row, mapping, 'Description')
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
