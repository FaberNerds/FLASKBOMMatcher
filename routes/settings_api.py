"""
BOM Matcher - Settings API Routes
Manages DB connection test and parameter index.
"""
import logging
from flask import Blueprint, request, jsonify

from services.search_service import test_connection
from services.category_index_service import build_index, get_index_stats

logger = logging.getLogger(__name__)

settings_bp = Blueprint('settings', __name__)


@settings_bp.route('/settings/test-connection', methods=['POST'])
def test_db_connection():
    """Test Exact DB connection using keyring credentials."""
    try:
        success, message = test_connection()
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        return jsonify({'success': False, 'message': f'Test failed: {str(e)}'}), 500


@settings_bp.route('/settings/rebuild-index', methods=['POST'])
def rebuild_index():
    """Rebuild the parameter index from ERP data."""
    try:
        logger.info("Parameter index rebuild requested")
        stats = build_index()
        return jsonify({
            'success': True,
            'stats': stats
        })
    except Exception as e:
        logger.error(f"rebuild_index error: {e}")
        return jsonify({'success': False, 'error': f'Rebuild failed: {str(e)}'}), 500


@settings_bp.route('/settings/index-stats', methods=['GET'])
def index_stats():
    """Get current parameter index statistics."""
    try:
        stats = get_index_stats()
        return jsonify({'success': True, 'stats': stats})
    except Exception as e:
        logger.error(f"index_stats error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500
