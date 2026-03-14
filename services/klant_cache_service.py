"""
BOM Matcher - Klant Cache Service
Loads all KlantNr/KlantNaam combinations from ItemClasses at startup
and provides lookup by KlantNr.
"""
import logging
import threading
from typing import Dict, Optional

from services.db_service import get_connection_context

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache: KlantNr -> KlantNaam
# ---------------------------------------------------------------------------
_klant_cache: Dict[str, str] = {}
_cache_loaded = False
_cache_lock = threading.Lock()


def _load_cache():
    """Load all KlantNr/KlantNaam pairs from ItemClasses (ClassID=2)."""
    global _klant_cache, _cache_loaded

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection for klant cache load")
            return
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT ItemClassCode, Description "
                "FROM ItemClasses WITH (NOLOCK) "
                "WHERE ClassID = 2"
            )
            cache = {}
            for row in cursor.fetchall():
                code = str(row.ItemClassCode).strip() if row.ItemClassCode else ""
                name = str(row.Description).strip() if row.Description else ""
                if code:
                    cache[code] = name

            _klant_cache = cache
            _cache_loaded = True
            logger.info(f"Klant cache loaded: {len(cache)} entries")
        except Exception as e:
            logger.error(f"Failed to load klant cache: {e}")


def ensure_loaded():
    """Ensure the cache is loaded (thread-safe, loads once)."""
    global _cache_loaded
    if not _cache_loaded:
        with _cache_lock:
            if not _cache_loaded:
                _load_cache()


def get_klant_naam(klant_nr: str) -> str:
    """Look up KlantNaam by KlantNr. Returns empty string if not found."""
    ensure_loaded()
    return _klant_cache.get(klant_nr, "")


def get_all_klanten() -> list:
    """Return all KlantNr/KlantNaam pairs as a list of dicts."""
    ensure_loaded()
    return [
        {"klant_nr": nr, "klant_naam": naam}
        for nr, naam in sorted(_klant_cache.items(), key=lambda x: x[1])
    ]


def find_klant_nr_by_name(name: str) -> Optional[str]:
    """Find KlantNr by (partial) KlantNaam match. Returns first match or None."""
    ensure_loaded()
    name_upper = name.strip().upper()
    for nr, naam in _klant_cache.items():
        if name_upper in naam.upper():
            return nr
    return None


def enrich_results(results: list) -> list:
    """Add KlantNaam to each result dict based on its KlantNr."""
    ensure_loaded()
    for r in results:
        klant_nr = r.get("KlantNr", "")
        r["KlantNaam"] = _klant_cache.get(klant_nr, "")
    return results
