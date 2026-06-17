"""
BOM Matcher - Exact BOM Service
Fetches a previous-version BOM (the recipe/components of an article) directly from
Exact Globe ERP, reusing the shared connection pool in db_service.

The SQL is ported verbatim from the BOM compare tool's services/exact_service.py
(GET_COMPONENTS_QUERY / GET_DESCRIPTION_QUERY) so the BOM is fetched identically.
Only the connection plumbing differs: instead of opening a fresh pyodbc connection
via credential_service, we borrow a connection from the existing pool (same
001 / FAB-SQL01 database, same keyring credentials).
"""
import logging
from typing import List, Dict, Tuple

from services.db_service import get_connection_context

logger = logging.getLogger(__name__)

# Ported verbatim from BOM compare services/exact_service.py (GET_COMPONENTS_QUERY).
GET_COMPONENTS_QUERY = """
SELECT
    r.itemreq as FaberNr,
    i.description as Description,
    i.Userfield_01 as Manufacturer,
    i.Userfield_02 as MPN,
    (r.quantity / rr.quantity) as Quantity,
    i.userfield_04 as Mounting,
    bacodiscussions.Body as Refdes
FROM recipe r WITH (NOLOCK)
LEFT JOIN bacodiscussions WITH (NOLOCK) on r.notesID = bacodiscussions.ID
LEFT OUTER JOIN items i WITH (NOLOCK) on r.itemreq = i.itemcode
LEFT OUTER JOIN items ii WITH (NOLOCK) on r.itemprod = ii.itemcode
LEFT OUTER JOIN Itemaccounts ia WITH (NOLOCK) on r.itemreq = ia.itemcode and ia.mainaccount = '1'
LEFT JOIN ItemAssortment ias WITH (NOLOCK) on ias.Assortment = i.Assortment
LEFT JOIN dbo.cicmpy WITH (NOLOCK) ON cicmpy.cmp_wwn = ia.AccountCode
LEFT JOIN dbo.recipe rr WITH (NOLOCK) on r.itemprod = rr.itemprod and rr.sequenceno = 0
LEFT JOIN staffl sl WITH (NOLOCK) on sl.artcode = i.ItemCode and ia.AccountCode = sl.AccountID
LEFT JOIN ItemClasses ic WITH (NOLOCK) on ic.ItemClassCode = i.Class_02 and ic.ClassID = 2
OUTER APPLY
(
    SELECT TOP 1
        o.ordernr as OrderNr,
        o.afldat as Leverdatum,
        o.esr_aantal as LeveringAantal
    FROM orsrg o
    WHERE o.afldat > GETDATE() and o.aant_gelev = 0 and o.artcode = i.ItemCode
    ORDER BY o.afldat
) o
OUTER APPLY
(
    SELECT TOP 1 (1 / rate_exchange) as Rate
    FROM rates r WITH (NOLOCK)
    WHERE r.target_currency = ia.PurchaseCurrency
    ORDER BY date_l DESC
) rates
WHERE 1=1
AND r.line_type = 'I'
AND r.variant <> 'W'
AND r.itemprod = ?
"""

# Ported verbatim from BOM compare services/exact_service.py (GET_DESCRIPTION_QUERY).
GET_DESCRIPTION_QUERY = """
SELECT [Omschrijving]
FROM [001].[dbo].[VEX_Items] WITH (NOLOCK)
WHERE [FaberNr] = ?
"""


def fetch_previous_bom(article_id: str) -> Tuple[List[Dict], str]:
    """Fetch BOM components for a previous-version article number from Exact.

    Returns (components, message). Each component:
        {FaberNr, Description, Manufacturer, MPN, Quantity, Mounting, Refdes}
    """
    article_id = (article_id or '').strip()
    if not article_id:
        return [], "Article number required"

    with get_connection_context() as conn:
        if not conn:
            logger.error("No database connection available for fetch_previous_bom")
            return [], "Database connection unavailable"
        try:
            cursor = conn.cursor()
            cursor.execute(GET_COMPONENTS_QUERY, (article_id,))

            components: List[Dict] = []
            for row in cursor.fetchall():
                components.append({
                    'FaberNr': str(row.FaberNr or '').strip(),
                    'Description': str(row.Description or ''),
                    'Manufacturer': str(row.Manufacturer or ''),
                    'MPN': str(row.MPN or ''),
                    'Quantity': float(row.Quantity or 0),
                    'Mounting': str(row.Mounting or ''),
                    'Refdes': str(row.Refdes or ''),
                })

            if not components:
                return [], f"No components found for article {article_id}"

            logger.info(f"Previous BOM {article_id}: {len(components)} components fetched from Exact")
            return components, f"Found {len(components)} components"
        except Exception as e:
            logger.error(f"fetch_previous_bom error: {e}")
            return [], f"Database error: {str(e)}"


def get_description(article_id: str) -> str:
    """Return the Exact description (Omschrijving) for an article number, or ''."""
    article_id = (article_id or '').strip()
    if not article_id:
        return ""

    with get_connection_context() as conn:
        if not conn:
            return ""
        try:
            cursor = conn.cursor()
            cursor.execute(GET_DESCRIPTION_QUERY, (article_id,))
            row = cursor.fetchone()
            if row and row[0]:
                return str(row[0])
            return ""
        except Exception as e:
            logger.error(f"get_description error: {e}")
            return ""
