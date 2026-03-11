"""
BOM Matcher - Session Service
Handles Flask session management and BOM data storage for single-BOM flow.
"""
import uuid
import json
import logging
from pathlib import Path
from flask import session
import config

logger = logging.getLogger(__name__)


def get_session_id() -> str:
    """Get or create a unique session identifier."""
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
    return session['session_id']


def _get_path(session_id: str, suffix: str) -> Path:
    """Get storage path for a session data file."""
    return config.UPLOAD_FOLDER / f"{session_id}_{suffix}.json"


def save_bom_data(data: dict) -> None:
    """Save BOM data (headers, rows, column mapping) to file storage."""
    session_id = get_session_id()
    path = _get_path(session_id, 'bom')
    with open(path, 'w') as f:
        json.dump(data, f)
    session['bom_loaded'] = True
    session['bom_name'] = data.get('name', 'BOM')
    session.modified = True


def load_bom_data() -> dict | None:
    """Load BOM data from file storage."""
    session_id = get_session_id()
    path = _get_path(session_id, 'bom')
    if not path.exists():
        return None
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error loading BOM data: {e}")
        return None


def save_matches(data: dict) -> None:
    """Save IPN search results (suggestions per row)."""
    session_id = get_session_id()
    path = _get_path(session_id, 'matches')
    with open(path, 'w') as f:
        json.dump(data, f)
    session.modified = True


def load_matches() -> dict | None:
    """Load IPN search results."""
    session_id = get_session_id()
    path = _get_path(session_id, 'matches')
    if not path.exists():
        return None
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error loading matches: {e}")
        return None


def save_mpnfree(data: dict) -> None:
    """Save MPNfree assessments."""
    session_id = get_session_id()
    path = _get_path(session_id, 'mpnfree')
    with open(path, 'w') as f:
        json.dump(data, f)
    session.modified = True


def load_mpnfree() -> dict | None:
    """Load MPNfree assessments."""
    session_id = get_session_id()
    path = _get_path(session_id, 'mpnfree')
    if not path.exists():
        return None
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error loading mpnfree data: {e}")
        return None


def save_selections(data: dict) -> None:
    """Save user's confirmed overrides."""
    session_id = get_session_id()
    path = _get_path(session_id, 'selections')
    with open(path, 'w') as f:
        json.dump(data, f)
    session.modified = True


def load_selections() -> dict | None:
    """Load user's confirmed overrides."""
    session_id = get_session_id()
    path = _get_path(session_id, 'selections')
    if not path.exists():
        return None
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error loading selections: {e}")
        return None


def get_session_data() -> dict:
    """Get session metadata for UI state restoration."""
    return {
        'bom_loaded': session.get('bom_loaded', False),
        'bom_name': session.get('bom_name'),
    }


def clear_session_data() -> None:
    """Clear all session data and associated temporary files."""
    session_id = session.get('session_id')
    if session_id:
        for suffix in ['bom', 'matches', 'mpnfree', 'selections']:
            path = _get_path(session_id, suffix)
            if path.exists():
                path.unlink()
    session.clear()
