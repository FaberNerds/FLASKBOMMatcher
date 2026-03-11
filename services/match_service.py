"""
BOM Matcher - Match Service
Parallel orchestrator for finding IPNs in Exact Globe.
Uses ThreadPoolExecutor for concurrent DB queries.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional

from services import search_service
from services.mpn_normalize_service import search_with_variants
from services.ai_service import generate_search_terms_batch
from services.credential_service import (
    get_mistral_api_key, get_openrouter_api_key,
    get_ai_provider, get_erp_examples
)

logger = logging.getLogger(__name__)


def _get_ai_credentials() -> tuple[str, str]:
    """Get active AI provider and API key."""
    provider = get_ai_provider()
    if provider == 'mistral':
        key = get_mistral_api_key()
    else:
        key = get_openrouter_api_key()
    return provider, key or ''


def _search_row_by_mpn(row_index: int, mpn: str) -> Dict[str, Any]:
    """Search a single row by MPN with variants."""
    results = search_with_variants(mpn, search_service.search_by_mpn)
    return {
        'row_index': row_index,
        'search_method': 'mpn',
        'suggestions': results,
        'auto_selected': results[0] if results else None,
        'confidence': 'high' if results and results[0].get('_exact_match') else ('medium' if results else 'none')
    }


def _search_row_by_ipn(row_index: int, ipn: str) -> Dict[str, Any]:
    """Verify/search a single row by existing IPN."""
    results = search_service.search_by_ipn(ipn)
    exact = [r for r in results if r.get('FaberNr', '').strip() == ipn.strip()]
    return {
        'row_index': row_index,
        'search_method': 'ipn_verify',
        'suggestions': results,
        'auto_selected': exact[0] if exact else (results[0] if results else None),
        'confidence': 'high' if exact else ('medium' if results else 'none')
    }


def _search_row_by_description(row_index: int, search_terms: List[str]) -> Dict[str, Any]:
    """Search a single row by description terms."""
    results = search_service.search_by_description(search_terms)
    return {
        'row_index': row_index,
        'search_method': 'description',
        'suggestions': results[:20],  # Limit description results
        'auto_selected': results[0] if results else None,
        'confidence': 'low' if results else 'none'
    }


def find_ipn_batch(bom_rows: List[Dict], column_mapping: Dict[str, str]) -> List[Dict[str, Any]]:
    """
    Find IPN for all BOM rows in parallel.

    Args:
        bom_rows: List of BOM row dicts (original data)
        column_mapping: Maps standard names to actual column headers
            e.g. {'MPN': 'Part Number', 'Description': 'Desc', 'FaberNr': 'IPN'}

    Returns:
        List of result dicts per row: {row_index, search_method, suggestions[], auto_selected, confidence}
    """
    mpn_col = column_mapping.get('MPN', '')
    desc_col = column_mapping.get('Description', '')
    ipn_col = column_mapping.get('FaberNr', '')

    # Phase 1: Categorize rows
    mpn_rows = []       # (row_index, mpn)
    ipn_rows = []       # (row_index, ipn)
    desc_rows = []      # (row_index, description) — need AI search terms

    for i, row in enumerate(bom_rows):
        mpn = row.get(mpn_col, '').strip() if mpn_col else ''
        ipn = row.get(ipn_col, '').strip() if ipn_col else ''
        desc = row.get(desc_col, '').strip() if desc_col else ''

        if mpn:
            mpn_rows.append((i, mpn))
        elif ipn:
            ipn_rows.append((i, ipn))
        elif desc:
            desc_rows.append((i, desc))

    logger.info(f"Categorized {len(bom_rows)} rows: {len(mpn_rows)} MPN, "
                f"{len(ipn_rows)} IPN verify, {len(desc_rows)} description-only")

    # Phase 2: Generate AI search terms for description-only rows
    desc_search_terms = {}  # row_index -> [terms]
    if desc_rows:
        provider, api_key = _get_ai_credentials()
        if api_key:
            erp_examples = get_erp_examples()
            ai_input = [{'description': desc, 'index': idx} for idx, desc in desc_rows]
            ai_results = generate_search_terms_batch(ai_input, erp_examples, api_key, provider)
            for r in ai_results:
                desc_search_terms[r['index']] = r.get('search_terms', [])
            logger.info(f"AI generated search terms for {len(ai_results)} rows")
        else:
            logger.warning("No AI API key configured — description-only rows will have no search terms")

    # Phase 3: Parallel search
    results = [None] * len(bom_rows)

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {}

        # Submit MPN searches
        for row_idx, mpn in mpn_rows:
            f = executor.submit(_search_row_by_mpn, row_idx, mpn)
            futures[f] = row_idx

        # Submit IPN verify searches
        for row_idx, ipn in ipn_rows:
            f = executor.submit(_search_row_by_ipn, row_idx, ipn)
            futures[f] = row_idx

        # Submit description searches
        for row_idx, desc in desc_rows:
            terms = desc_search_terms.get(row_idx, [])
            if terms:
                f = executor.submit(_search_row_by_description, row_idx, terms)
                futures[f] = row_idx
            else:
                # Fallback: split description into words
                words = desc.split()[:4]
                if words:
                    f = executor.submit(_search_row_by_description, row_idx, words)
                    futures[f] = row_idx

        # Collect results
        for future in as_completed(futures):
            row_idx = futures[future]
            try:
                results[row_idx] = future.result()
            except Exception as e:
                logger.error(f"Search failed for row {row_idx}: {e}")
                results[row_idx] = {
                    'row_index': row_idx,
                    'search_method': 'error',
                    'suggestions': [],
                    'auto_selected': None,
                    'confidence': 'none'
                }

    # Fill any rows that weren't searched
    for i in range(len(results)):
        if results[i] is None:
            results[i] = {
                'row_index': i,
                'search_method': 'skipped',
                'suggestions': [],
                'auto_selected': None,
                'confidence': 'none'
            }

    logger.info(f"Search complete: {sum(1 for r in results if r['confidence'] != 'none')}/{len(results)} rows matched")
    return results


def find_ipn_single(row_index: int, row: Dict, column_mapping: Dict[str, str]) -> Dict[str, Any]:
    """Re-search a single row."""
    mpn_col = column_mapping.get('MPN', '')
    desc_col = column_mapping.get('Description', '')
    ipn_col = column_mapping.get('FaberNr', '')

    mpn = row.get(mpn_col, '').strip() if mpn_col else ''
    ipn = row.get(ipn_col, '').strip() if ipn_col else ''
    desc = row.get(desc_col, '').strip() if desc_col else ''

    if mpn:
        return _search_row_by_mpn(row_index, mpn)
    elif ipn:
        return _search_row_by_ipn(row_index, ipn)
    elif desc:
        # Try AI search terms
        provider, api_key = _get_ai_credentials()
        if api_key:
            erp_examples = get_erp_examples()
            ai_results = generate_search_terms_batch(
                [{'description': desc, 'index': row_index}],
                erp_examples, api_key, provider
            )
            if ai_results and ai_results[0].get('search_terms'):
                return _search_row_by_description(row_index, ai_results[0]['search_terms'])

        # Fallback to word splitting
        words = desc.split()[:4]
        if words:
            return _search_row_by_description(row_index, words)

    return {
        'row_index': row_index,
        'search_method': 'skipped',
        'suggestions': [],
        'auto_selected': None,
        'confidence': 'none'
    }
