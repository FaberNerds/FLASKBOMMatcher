"""
BOM Matcher - Search Service
Wrapper around ExactSearchTool search_logic.py.
Uses keyring-based credentials from Windows Credential Manager.
"""
import sys
import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

# Add the FLASK project root to sys.path so we can import core modules
_FLASK_ROOT = r"c:\Users\DanielHatert\PycharmProjects\PythonProject1\FLASK"
if _FLASK_ROOT not in sys.path:
    sys.path.insert(0, _FLASK_ROOT)

_search_logic = None


def _get_search_logic():
    """Lazy-load search_logic to avoid import errors at startup."""
    global _search_logic
    if _search_logic is None:
        try:
            from core.ExactSearchTool.search_logic import (
                search_component_by_mpn,
                search_component_by_description,
                search_component_by_ipn
            )
            _search_logic = {
                'by_mpn': search_component_by_mpn,
                'by_description': search_component_by_description,
                'by_ipn': search_component_by_ipn,
            }
            logger.info("ExactSearchTool search_logic loaded successfully")
        except Exception as e:
            logger.error(f"Failed to import search_logic: {e}")
            _search_logic = {}
    return _search_logic


def search_by_mpn(mpn: str) -> List[Dict[str, Any]]:
    """Search Exact by Manufacturer Part Number."""
    sl = _get_search_logic()
    fn = sl.get('by_mpn')
    if not fn:
        logger.error("search_component_by_mpn not available")
        return []
    try:
        return fn(mpn)
    except Exception as e:
        logger.error(f"search_by_mpn error: {e}")
        return []


def search_by_description(terms: List[str]) -> List[Dict[str, Any]]:
    """Search Exact by description terms (AND logic)."""
    sl = _get_search_logic()
    fn = sl.get('by_description')
    if not fn:
        logger.error("search_component_by_description not available")
        return []
    try:
        return fn(terms)
    except Exception as e:
        logger.error(f"search_by_description error: {e}")
        return []


def search_by_ipn(ipn: str) -> List[Dict[str, Any]]:
    """Search Exact by Internal Part Number (FaberNr)."""
    sl = _get_search_logic()
    fn = sl.get('by_ipn')
    if not fn:
        logger.error("search_component_by_ipn not available")
        return []
    try:
        return fn(ipn)
    except Exception as e:
        logger.error(f"search_by_ipn error: {e}")
        return []


def test_connection() -> tuple[bool, str]:
    """Test the Exact DB connection via keyring credentials."""
    try:
        from core.LuminovoExactSync.exactimport import get_connection_context
        with get_connection_context() as conn:
            if conn:
                return True, "Connection successful"
            else:
                return False, "No connection returned"
    except Exception as e:
        return False, f"Connection failed: {str(e)}"
