"""
BOM Matcher - Match API Routes
Handles IPN finding, MPNfree assessment, and overrides.
"""
import logging
from flask import Blueprint, request, jsonify

from services.session_service import (
    load_bom_data, save_matches, load_matches,
    save_mpnfree, load_mpnfree,
    save_selections, load_selections
)
from services.match_service import find_ipn_batch, find_ipn_single
from services.ai_service import assess_mpnfree_batch
from services.credential_service import (
    get_mistral_api_key, get_openrouter_api_key, get_ai_provider
)

logger = logging.getLogger(__name__)

match_bp = Blueprint('match', __name__)


@match_bp.route('/match/find-ipn', methods=['POST'])
def find_ipn():
    """Batch find IPN for all BOM rows."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No BOM data loaded'}), 400

    rows = bom_data.get('rows', [])
    mapping = bom_data.get('column_mapping', {})

    if not rows:
        return jsonify({'error': 'BOM has no rows'}), 400

    try:
        results = find_ipn_batch(rows, mapping)

        # Convert to dict keyed by row index for storage
        matches_dict = {}
        for r in results:
            matches_dict[str(r['row_index'])] = r

        save_matches(matches_dict)

        return jsonify({
            'success': True,
            'results': results,
            'matched': sum(1 for r in results if r['confidence'] != 'none'),
            'total': len(results)
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

    try:
        result = find_ipn_single(row_index, rows[row_index], mapping)

        # Update stored matches
        matches = load_matches() or {}
        matches[str(row_index)] = result
        save_matches(matches)

        return jsonify({'success': True, 'result': result})
    except Exception as e:
        logger.error(f"find_ipn_single error: {e}")
        return jsonify({'error': f'Search failed: {str(e)}'}), 500


@match_bp.route('/match/mpnfree', methods=['POST'])
def assess_mpnfree():
    """Batch MPNfree assessment using AI."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'No BOM data loaded'}), 400

    rows = bom_data.get('rows', [])
    mapping = bom_data.get('column_mapping', {})

    if not rows:
        return jsonify({'error': 'BOM has no rows'}), 400

    # Get AI credentials
    provider = get_ai_provider()
    api_key = get_mistral_api_key() if provider == 'mistral' else get_openrouter_api_key()
    if not api_key:
        return jsonify({'error': f'No API key configured for {provider}. Configure in Settings.'}), 400

    try:
        mpn_col = mapping.get('MPN', '')
        mfr_col = mapping.get('Manufacturer', '')
        desc_col = mapping.get('Description', '')

        ai_input = []
        for i, row in enumerate(rows):
            ai_input.append({
                'index': i,
                'mpn': row.get(mpn_col, '') if mpn_col else '',
                'manufacturer': row.get(mfr_col, '') if mfr_col else '',
                'description': row.get(desc_col, '') if desc_col else ''
            })

        results = assess_mpnfree_batch(ai_input, api_key, provider)

        # Store keyed by row index
        mpnfree_dict = {}
        for r in results:
            mpnfree_dict[str(r['index'])] = r

        save_mpnfree(mpnfree_dict)

        return jsonify({
            'success': True,
            'results': results,
            'mpnfree_count': sum(1 for r in results if r.get('mpnfree')),
            'total': len(results)
        })
    except Exception as e:
        logger.error(f"assess_mpnfree error: {e}")
        return jsonify({'error': f'MPNfree assessment failed: {str(e)}'}), 500


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
