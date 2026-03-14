"""
BOM Matcher - Settings API Routes
Manages DB connection test and parameter index.
"""
import logging
from flask import Blueprint, request, jsonify

from services.search_service import test_connection
from services.category_index_service import build_index, get_index_stats
from services.package_alias_service import get_aliases, add_alias, remove_alias

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


@settings_bp.route('/settings/package-aliases', methods=['GET'])
def list_package_aliases():
    """Return all configured package aliases."""
    try:
        return jsonify({'success': True, 'aliases': get_aliases()})
    except Exception as e:
        logger.error(f"list_package_aliases error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@settings_bp.route('/settings/package-aliases', methods=['POST'])
def add_package_alias():
    """Add a new package alias."""
    try:
        data = request.get_json(force=True)
        pattern = data.get('pattern', '')
        package = data.get('package', '')
        alias = add_alias(pattern, package)
        return jsonify({'success': True, 'alias': alias})
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"add_package_alias error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@settings_bp.route('/settings/package-aliases', methods=['DELETE'])
def delete_package_alias():
    """Remove a package alias by pattern."""
    try:
        data = request.get_json(force=True)
        pattern = data.get('pattern', '')
        if remove_alias(pattern):
            return jsonify({'success': True})
        return jsonify({'success': False, 'error': 'Alias not found'}), 404
    except Exception as e:
        logger.error(f"delete_package_alias error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500
