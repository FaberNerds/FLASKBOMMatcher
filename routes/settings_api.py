"""
BOM Matcher - Settings API Routes
Manages API keys, AI provider, ERP examples, and DB connection test.
"""
import logging
from flask import Blueprint, request, jsonify

from services.credential_service import (
    save_mistral_credentials, get_mistral_api_key,
    save_openrouter_credentials, get_openrouter_api_key,
    save_ollama_settings, get_ollama_settings,
    save_ai_provider, get_ai_provider,
    save_erp_examples, get_erp_examples,
    mask_secret
)
from services.search_service import test_connection
from services.category_index_service import build_index, get_index_stats

logger = logging.getLogger(__name__)

settings_bp = Blueprint('settings', __name__)


@settings_bp.route('/settings/mistral', methods=['GET', 'POST'])
def mistral_key():
    if request.method == 'POST':
        data = request.get_json()
        api_key = data.get('api_key', '').strip()
        if not api_key:
            return jsonify({'error': 'API key required'}), 400
        save_mistral_credentials(api_key)
        return jsonify({'success': True, 'masked_key': mask_secret(api_key)})
    else:
        key = get_mistral_api_key()
        return jsonify({
            'configured': bool(key),
            'masked_key': mask_secret(key) if key else None
        })


@settings_bp.route('/settings/openrouter', methods=['GET', 'POST'])
def openrouter_key():
    if request.method == 'POST':
        data = request.get_json()
        api_key = data.get('api_key', '').strip()
        if not api_key:
            return jsonify({'error': 'API key required'}), 400
        save_openrouter_credentials(api_key)
        return jsonify({'success': True, 'masked_key': mask_secret(api_key)})
    else:
        key = get_openrouter_api_key()
        return jsonify({
            'configured': bool(key),
            'masked_key': mask_secret(key) if key else None
        })


@settings_bp.route('/settings/ollama', methods=['GET', 'POST'])
def ollama_settings():
    if request.method == 'POST':
        data = request.get_json()
        host = data.get('host', '').strip()
        model = data.get('model', '').strip()
        if not host:
            return jsonify({'error': 'Ollama host URL required'}), 400
        if not model:
            return jsonify({'error': 'Model name required'}), 400
        save_ollama_settings(host, model)
        return jsonify({'success': True, 'host': host, 'model': model})
    else:
        settings = get_ollama_settings()
        return jsonify({
            'configured': True,
            'host': settings['host'],
            'model': settings['model']
        })


@settings_bp.route('/settings/ai-provider', methods=['GET', 'POST'])
def ai_provider():
    if request.method == 'POST':
        data = request.get_json()
        provider = data.get('provider', '').strip()
        try:
            save_ai_provider(provider)
            return jsonify({'success': True, 'provider': provider})
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
    else:
        return jsonify({'provider': get_ai_provider()})


@settings_bp.route('/settings/erp-examples', methods=['GET', 'POST'])
def erp_examples():
    if request.method == 'POST':
        data = request.get_json()
        examples = data.get('examples', '').strip()
        save_erp_examples(examples)
        return jsonify({'success': True})
    else:
        return jsonify({'examples': get_erp_examples()})


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
