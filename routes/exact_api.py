"""
BOM Matcher - Exact API Routes
Fetches a previous-version BOM from Exact and exposes it for matching/checkmarks.
"""
import logging
from flask import Blueprint, request, jsonify

from services import exact_bom_service
from services.session_service import load_bom_data, save_bom_data, save_matches

logger = logging.getLogger(__name__)

exact_bp = Blueprint('exact', __name__)


@exact_bp.route('/exact/fetch-previous', methods=['POST'])
def fetch_previous():
    """Fetch the BOM of a previous-version article number from Exact and store it.

    The fetched BOM is saved onto the current session's bom_data so that
    Process BOM matches the new BOM against it instead of the live ERP catalog.
    """
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'error': 'Upload a BOM file first'}), 400

    data = request.get_json() or {}
    article_id = (data.get('article_id') or '').strip()
    if not article_id:
        return jsonify({'error': 'Article number required'}), 400

    components, message = exact_bom_service.fetch_previous_bom(article_id)
    if not components:
        return jsonify({'error': message}), 404

    description = exact_bom_service.get_description(article_id)

    bom_data['previous_bom'] = components
    bom_data['previous_article_id'] = article_id
    bom_data['previous_description'] = description
    save_bom_data(bom_data)

    # Clear stored matches so the process page auto-run regenerates against this new baseline
    # (handles re-fetching a different previous article). MPNfree/selections are left intact.
    save_matches({})

    logger.info(f"Stored previous BOM {article_id}: {len(components)} components")
    return jsonify({
        'success': True,
        'article_id': article_id,
        'description': description,
        'total_rows': len(components),
        'preview': components[:50],
        'message': message,
    })


@exact_bp.route('/exact/clear-previous', methods=['POST'])
def clear_previous():
    """Remove the stored previous BOM (revert to normal live ERP matching)."""
    bom_data = load_bom_data()
    if not bom_data:
        return jsonify({'success': True})
    for key in ('previous_bom', 'previous_article_id', 'previous_description'):
        bom_data.pop(key, None)
    save_bom_data(bom_data)
    return jsonify({'success': True})


@exact_bp.route('/exact/previous-bom', methods=['GET'])
def previous_bom():
    """Return the stored previous-BOM lines (for the green-checkmark feature).

    Returns {'components': [...], 'article_id': ...}; components is [] if none loaded.
    """
    bom_data = load_bom_data()
    components = (bom_data or {}).get('previous_bom', []) or []
    return jsonify({
        'components': components,
        'article_id': (bom_data or {}).get('previous_article_id', ''),
        'description': (bom_data or {}).get('previous_description', ''),
    })
