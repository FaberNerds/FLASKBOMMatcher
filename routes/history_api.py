"""
BOM Matcher - History API Routes
Browse, load, and delete saved BOM history entries.
"""
from flask import Blueprint, request, jsonify
from services.session_service import (
    load_history, delete_history_entry, load_history_session
)

history_bp = Blueprint('history', __name__)


@history_bp.route('/history', methods=['GET'])
def list_history():
    """Return all history entries."""
    entries = load_history()
    return jsonify({'entries': entries})


@history_bp.route('/history/load', methods=['POST'])
def load_entry():
    """Load a history entry into the current session."""
    data = request.get_json()
    session_id = data.get('session_id')
    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    success = load_history_session(session_id)
    if success:
        return jsonify({'success': True})
    return jsonify({'error': 'History entry not found'}), 404


@history_bp.route('/history/delete', methods=['POST'])
def delete_entry():
    """Delete a history entry and its files."""
    data = request.get_json()
    session_id = data.get('session_id')
    if not session_id:
        return jsonify({'error': 'session_id required'}), 400

    delete_history_entry(session_id)
    return jsonify({'success': True})
