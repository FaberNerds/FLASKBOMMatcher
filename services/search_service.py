"""
BOM Matcher - Search Service
Direct SQL queries against Exact Globe ERP for component search.
"""
import logging
import threading
import time
from typing import List, Dict, Any

from services.db_service import get_connection_context
from services.klant_cache_service import enrich_results as _enrich_klant

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thread-safe TTL cache for search results
# ---------------------------------------------------------------------------
_search_cache: Dict[str, tuple] = {}  # key -> (results, timestamp)
_cache_lock = threading.Lock()
_CACHE_TTL = 120  # seconds


def clear_search_cache():
    """Clear the search cache (call at start of batch operations)."""
    global _search_cache
    with _cache_lock:
        _search_cache = {}


def _cache_get(key: str) -> List[Dict[str, Any]] | None:
    """Get cached result if still valid."""
    with _cache_lock:
        entry = _search_cache.get(key)
        if entry and time.time() - entry[1] < _CACHE_TTL:
            return entry[0]
    return None


def _cache_set(key: str, results: List[Dict[str, Any]]):
    """Store result in cache."""
    with _cache_lock:
        _search_cache[key] = (results, time.time())

# ---------------------------------------------------------------------------
# Shared SQL SELECT clause (used by all three search functions)
# ---------------------------------------------------------------------------
_BASE_SELECT = """
    SELECT
        i.ItemCode as FaberNr,
        i.Description_0 as Omschrijving,
        i.UserField_01 as Manufacturer,
        i.UserField_02 as MPN,
        i.Class_02 as KlantNr,
        i.WareHouse as Magazijn,
        i.UserField_04 as Mounting,
        ic.Description as Type,
        CASE
            WHEN i.Condition = 'A' THEN 'Actief'
            WHEN i.Condition = 'B' THEN 'Geblokkeerd'
            WHEN i.Condition = 'D' THEN 'Vervallen'
            WHEN i.Condition = 'F' THEN 'Toekomstig'
            WHEN i.Condition = 'E' THEN 'Non-actief'
            ELSE 'Onbekend'
        END AS Status,
        ISNULL(i.CostPriceStandard,0) as Kostprijs,
        Voorraad = ISNULL((Select SUM(sb.Quantity) from StockBalances sb WITH (NOLOCK) where sb.ItemCode = i.ItemCode),0),
        Verbruik = ISNULL((Select SUM(g.aantal) from gbkmut g WITH (NOLOCK) where 1=1 and g.artcode = i.itemcode and g.reknr = i.GLAccountDistribution and LEFT(g.project,2) = 'PR' and g.datum > GETDATE() and g.datum < DATEADD(month,3,GETDATE()) and g.aantal < 0),0),
        InBestelling = ISNULL((Select SUM(g.aantal)*-1 from gbkmut g WITH (NOLOCK) where g.artcode = i.ItemCode and g.reknr = 1600 and g.bud_vers = 'MRP' and g.datum > GETDATE() and g.datum < DATEADD(month,3,GETDATE())),0)
    from items i
    left join ItemClasses ic on ic.ClassID = 1 and ic.ItemClassCode = i.Class_01
"""


def _row_to_dict(row) -> Dict[str, Any]:
    """Convert a pyodbc Row to the standard component dictionary."""
    return {
        "FaberNr": str(row.FaberNr).strip() if row.FaberNr else "",
        "Omschrijving": str(row.Omschrijving).strip() if row.Omschrijving else "",
        "Manufacturer": str(row.Manufacturer).strip() if row.Manufacturer else "",
        "MPN": str(row.MPN).strip() if row.MPN else "",
        "KlantNr": str(row.KlantNr).strip() if row.KlantNr else "",
        "Magazijn": str(row.Magazijn).strip() if row.Magazijn else "",
        "Mounting": str(row.Mounting).strip() if row.Mounting else "",
        "Type": str(row.Type).strip() if row.Type else "",
        "Status": str(row.Status).strip() if row.Status else "",
        "Kostprijs": float(row.Kostprijs) if row.Kostprijs else 0.0,
        "Voorraad": float(row.Voorraad) if row.Voorraad else 0.0,
        "Verbruik": float(row.Verbruik) if row.Verbruik else 0.0,
        "InBestelling": float(row.InBestelling) if row.InBestelling else 0.0,
    }


def search_by_mpn(mpn: str) -> List[Dict[str, Any]]:
    """Search Exact by Manufacturer Part Number (LIKE '%mpn%')."""
    if not mpn:
        return []

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection available for search_by_mpn")
            return []
        try:
            cursor = conn.cursor()
            query = _BASE_SELECT + " where i.UserField_02 LIKE ?"
            search_term = f"%{mpn}%"
            logger.debug(f"SQL: WHERE UserField_02 LIKE '{search_term}'")
            cursor.execute(query, [search_term])
            results = [_row_to_dict(row) for row in cursor.fetchall()]
            logger.info(f"MPN LIKE '%{mpn}%' → {len(results)} rows")
            return _enrich_klant(results)
        except Exception as e:
            logger.error(f"search_by_mpn error: {e}")
            return []


def search_by_description(terms: List[str]) -> List[Dict[str, Any]]:
    """Search Exact by description terms (AND logic, each term LIKE '%term%')."""
    if not terms or not any(terms):
        return []

    clean_terms = [t.strip() for t in terms if t and t.strip()]
    if not clean_terms:
        return []

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection available for search_by_description")
            return []
        try:
            cursor = conn.cursor()
            query = _BASE_SELECT + " where 1=1"
            params = []
            for term in clean_terms:
                query += " and i.Description_0 like ?"
                params.append(f"%{term}%")

            logger.debug(f"SQL: WHERE Description_0 LIKE {' AND '.join(repr(p) for p in params)}")
            cursor.execute(query, params)
            results = [_row_to_dict(row) for row in cursor.fetchall()]
            logger.info(f"DESC {clean_terms} → {len(results)} rows")
            return _enrich_klant(results)
        except Exception as e:
            logger.error(f"search_by_description error: {e}")
            return []


def search_by_ipn(ipn: str) -> List[Dict[str, Any]]:
    """Search Exact by Internal Part Number / FaberNr (prefix LIKE 'ipn%')."""
    if not ipn:
        return []

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection available for search_by_ipn")
            return []
        try:
            cursor = conn.cursor()
            query = _BASE_SELECT + " where i.ItemCode LIKE ?"
            search_term = f"{ipn}%"
            logger.debug(f"SQL: WHERE ItemCode LIKE '{search_term}'")
            cursor.execute(query, [search_term])
            results = [_row_to_dict(row) for row in cursor.fetchall()]
            logger.info(f"IPN LIKE '{ipn}%' → {len(results)} rows")
            return _enrich_klant(results)
        except Exception as e:
            logger.error(f"search_by_ipn error: {e}")
            return []


def search_by_item_codes(item_codes: List[str]) -> List[Dict[str, Any]]:
    """Batch fetch components from ERP by ItemCode list (WHERE ItemCode IN (...))."""
    if not item_codes:
        return []

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection available for search_by_item_codes")
            return []
        try:
            cursor = conn.cursor()
            placeholders = ",".join("?" * len(item_codes))
            query = _BASE_SELECT + f" WHERE i.ItemCode IN ({placeholders})"
            cursor.execute(query, item_codes)
            results = [_row_to_dict(row) for row in cursor.fetchall()]
            logger.info(f"ItemCode batch ({len(item_codes)} codes) → {len(results)} rows")
            return _enrich_klant(results)
        except Exception as e:
            logger.error(f"search_by_item_codes error: {e}")
            return []


def search_by_mpn_and_manufacturer(mpn: str, manufacturer: str = "") -> List[Dict[str, Any]]:
    """Search by MPN with optional manufacturer filtering/boosting."""
    if not mpn:
        return []

    results = search_by_mpn(mpn)

    if manufacturer and results:
        mfr_upper = manufacturer.upper().strip()
        # Separate results into manufacturer matches and others
        mfr_matches = []
        others = []
        for r in results:
            if mfr_upper in (r.get('Manufacturer', '') or '').upper():
                mfr_matches.append(r)
            else:
                others.append(r)
        # Return manufacturer matches first, then others
        results = mfr_matches + others

    return results


def search_by_mpn_variants(variants: List[str], manufacturer: str = "") -> List[Dict[str, Any]]:
    """Search Exact by multiple MPN variants in a single query (OR logic).

    Combines all variants into one SQL query instead of making separate calls.
    Returns results with manufacturer boosting if manufacturer is provided.
    """
    if not variants:
        return []

    # Check cache
    cache_key = f"mpn_variants:{'|'.join(v.upper() for v in variants)}:{manufacturer.upper()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        logger.debug(f"Cache hit for MPN variants {variants}")
        return cached

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection available for search_by_mpn_variants")
            return []
        try:
            cursor = conn.cursor()
            or_clauses = " OR ".join(["i.UserField_02 LIKE ?"] * len(variants))
            query = _BASE_SELECT + f" WHERE ({or_clauses})"
            params = [f"%{v}%" for v in variants]
            logger.debug(f"SQL: WHERE ({' OR '.join(f'UserField_02 LIKE %{v}%' for v in variants)})")
            cursor.execute(query, params)
            results = _enrich_klant([_row_to_dict(row) for row in cursor.fetchall()])
            logger.info(f"MPN variants {variants} → {len(results)} rows (1 query)")

            # Boost manufacturer matches to top
            if manufacturer and results:
                mfr_upper = manufacturer.upper().strip()
                mfr_matches = []
                others = []
                for r in results:
                    if mfr_upper in (r.get('Manufacturer', '') or '').upper():
                        mfr_matches.append(r)
                    else:
                        others.append(r)
                results = mfr_matches + others

            _cache_set(cache_key, results)
            return results
        except Exception as e:
            logger.error(f"search_by_mpn_variants error: {e}")
            return []


def test_connection() -> tuple[bool, str]:
    """Test the Exact DB connection."""
    try:
        with get_connection_context() as conn:
            if conn:
                return True, "Connection successful"
            return False, "No connection returned"
    except Exception as e:
        return False, f"Connection failed: {str(e)}"
