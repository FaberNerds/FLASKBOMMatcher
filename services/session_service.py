"""
BOM Matcher - Session Service
Handles Flask session management and BOM data storage for single-BOM flow.
"""
import uuid
import json
import shutil
import logging
from datetime import datetime
from pathlib import Path
from flask import session
import config

MAPPING_HISTORY_PATH = config.UPLOAD_FOLDER / 'mapping_history.json'
HISTORY_PATH = config.UPLOAD_FOLDER / 'bom_history.json'
MAX_HISTORY = 100

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


def save_mapping_history(filename: str, settings: dict) -> None:
    """Persist column mapping and settings for a filename so they can be restored on re-upload."""
    history = {}
    if MAPPING_HISTORY_PATH.exists():
        try:
            with open(MAPPING_HISTORY_PATH, 'r') as f:
                history = json.load(f)
        except Exception:
            history = {}

    history[filename] = {
        'column_mapping': settings.get('column_mapping', {}),
        'klant_nr': settings.get('klant_nr', ''),
        'header_row': settings.get('header_row', 0),
        'sheet_name': settings.get('sheet_name'),
        'start_row': settings.get('start_row'),
        'end_row': settings.get('end_row'),
        'saved_at': datetime.now().isoformat(),
    }

    with open(MAPPING_HISTORY_PATH, 'w') as f:
        json.dump(history, f)


def load_mapping_history(filename: str) -> dict | None:
    """Load previously stored settings for a filename, or None if not found."""
    if not MAPPING_HISTORY_PATH.exists():
        return None
    try:
        with open(MAPPING_HISTORY_PATH, 'r') as f:
            history = json.load(f)
        return history.get(filename)
    except Exception:
        return None


def clear_session_data() -> None:
    """Clear all session data and associated temporary files."""
    session_id = session.get('session_id')
    if session_id:
        for suffix in ['bom', 'matches', 'mpnfree', 'selections']:
            path = _get_path(session_id, suffix)
            if path.exists():
                path.unlink()
    session.clear()


# ========================================================================
# BOM History
# ========================================================================

def save_to_history(session_id: str, bom_name: str, klant_nr: str = '') -> None:
    """Save/update current session state as a history entry."""
    history = load_history()

    # Count rows from BOM data
    row_count = 0
    bom_path = _get_path(session_id, 'bom')
    if bom_path.exists():
        try:
            with open(bom_path, 'r') as f:
                bom = json.load(f)
            row_count = len(bom.get('rows', []))
        except Exception:
            pass

    entry = {
        'session_id': session_id,
        'bom_name': bom_name,
        'klant_nr': klant_nr,
        'row_count': row_count,
        'saved_at': datetime.now().isoformat(),
        'has_matches': _get_path(session_id, 'matches').exists(),
        'has_mpnfree': _get_path(session_id, 'mpnfree').exists(),
        'has_selections': _get_path(session_id, 'selections').exists(),
    }

    # Remove existing entry for same session_id if present
    history = [h for h in history if h['session_id'] != session_id]

    # Prepend new entry (most recent first)
    history.insert(0, entry)

    # Trim to max, cleaning up files for evicted entries
    while len(history) > MAX_HISTORY:
        removed = history.pop()
        _cleanup_history_files(removed['session_id'])

    with open(HISTORY_PATH, 'w') as f:
        json.dump(history, f)


def load_history() -> list:
    """Load history entries list."""
    if not HISTORY_PATH.exists():
        return []
    try:
        with open(HISTORY_PATH, 'r') as f:
            return json.load(f)
    except Exception:
        return []


def delete_history_entry(target_session_id: str) -> None:
    """Remove a specific history entry and its files."""
    history = load_history()
    history = [h for h in history if h['session_id'] != target_session_id]
    with open(HISTORY_PATH, 'w') as f:
        json.dump(history, f)
    _cleanup_history_files(target_session_id)


def load_history_session(target_session_id: str) -> bool:
    """Load a history entry into the current session by copying its data files."""
    current_session_id = get_session_id()
    if target_session_id == current_session_id:
        return True  # Already the active session

    # Copy each data file from target to current session
    for suffix in ['bom', 'matches', 'mpnfree', 'selections']:
        src = _get_path(target_session_id, suffix)
        dst = _get_path(current_session_id, suffix)
        if src.exists():
            shutil.copy2(src, dst)
        elif dst.exists():
            dst.unlink()

    # Update session metadata from the loaded BOM data
    bom_path = _get_path(current_session_id, 'bom')
    if bom_path.exists():
        try:
            with open(bom_path, 'r') as f:
                bom_data = json.load(f)
            session['bom_loaded'] = True
            session['bom_name'] = bom_data.get('name', 'BOM')
            session.modified = True
        except Exception:
            pass

    return True


def _cleanup_history_files(target_session_id: str) -> None:
    """Remove all data files for a session (used when evicting from history)."""
    # Don't delete if it's the current active session
    current = session.get('session_id')
    if current and current == target_session_id:
        return
    for suffix in ['bom', 'matches', 'mpnfree', 'selections']:
        path = _get_path(target_session_id, suffix)
        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass
