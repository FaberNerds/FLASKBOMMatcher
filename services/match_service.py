"""
BOM Matcher - Match Service
Parallel orchestrator for finding IPNs in Exact Globe.
Uses ThreadPoolExecutor for concurrent DB queries.
Supports parameterized matching for resistors/capacitors via SQLite index.
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
from services.category_detect_service import detect_category, is_generic_rc
from services.category_index_service import search_by_parameters
from services.param_extract_service import (
    extract_parameters, get_match_highlights, get_mpn_highlights
)

logger = logging.getLogger(__name__)


def _get_ai_credentials() -> tuple[str, str]:
    """Get active AI provider and API key."""
    provider = get_ai_provider()
    if provider == 'mistral':
        key = get_mistral_api_key()
    elif provider == 'ollama':
        key = 'ollama-local'
    else:
        key = get_openrouter_api_key()
    return provider, key or ''


def _search_row_by_mpn(row_index: int, mpn: str, manufacturer: str = "") -> Dict[str, Any]:
    """Search a single row by MPN with variants, boosted by manufacturer."""
    if manufacturer:
        results = search_with_variants(
            mpn, lambda m: search_service.search_by_mpn_and_manufacturer(m, manufacturer)
        )
    else:
        results = search_with_variants(mpn, search_service.search_by_mpn)

    confidence = 'high' if results and results[0].get('_exact_match') else ('medium' if results else 'none')
    auto = results[0] if results else None
    auto_str = f" → {auto['FaberNr']}" if auto else ""
    logger.info(f"Row {row_index}: MPN '{mpn}' — {len(results)} hits, {confidence}{auto_str}")

    # Add MPN highlights for each suggestion
    for s in results[:20]:
        s['_mpn_highlights'] = get_mpn_highlights(mpn, s.get('Omschrijving', ''))

    return {
        'row_index': row_index,
        'search_method': 'mpn',
        'suggestions': results[:20],
        'auto_selected': auto,
        'confidence': confidence
    }


def _search_row_by_ipn(row_index: int, ipn: str) -> Dict[str, Any]:
    """Verify/search a single row by existing IPN."""
    results = search_service.search_by_ipn(ipn)
    exact = [r for r in results if r.get('FaberNr', '').strip() == ipn.strip()]
    confidence = 'high' if exact else ('medium' if results else 'none')
    auto = exact[0] if exact else (results[0] if results else None)
    auto_str = f" → {auto['FaberNr']}" if auto else ""
    logger.info(f"Row {row_index}: IPN '{ipn}' — {len(results)} hits, {len(exact)} exact, {confidence}{auto_str}")
    return {
        'row_index': row_index,
        'search_method': 'ipn_verify',
        'suggestions': results,
        'auto_selected': auto,
        'confidence': confidence
    }


def _search_row_by_description(row_index: int, search_terms: List[str]) -> Dict[str, Any]:
    """Search a single row by description terms."""
    results = search_service.search_by_description(search_terms)
    confidence = 'low' if results else 'none'
    auto = results[0] if results else None
    auto_str = f" → {auto['FaberNr']}" if auto else ""
    logger.info(f"Row {row_index}: DESC {search_terms} — {len(results)} hits, {confidence}{auto_str}")
    return {
        'row_index': row_index,
        'search_method': 'description',
        'suggestions': results[:20],
        'auto_selected': auto,
        'confidence': confidence
    }


def _search_row_by_parameters(row_index: int, description: str, category: str) -> Dict[str, Any]:
    """Search a single row using parameterized matching against the SQLite index.

    1. Extract parameters from customer description
    2. Search SQLite index by category + params
    3. Verify top candidates via live ERP batch fetch
    4. Return scored results with highlight data
    """
    # Extract parameters from customer description
    params = extract_parameters(description, category)
    if not params:
        logger.info(f"Row {row_index}: PARAM no params extracted from '{description[:60]}' [{category}]")
        return None  # Signal to fall back

    # Search SQLite index
    index_results = search_by_parameters(category, params, limit=20)
    if not index_results:
        logger.info(f"Row {row_index}: PARAM no index hits for {params} [{category}]")
        return None  # Signal to fall back

    # Verify top candidates via live ERP
    item_codes = [r['item_code'] for r in index_results]
    erp_results = search_service.search_by_item_codes(item_codes)

    # Build lookup from ERP results
    erp_lookup = {r['FaberNr'].strip(): r for r in erp_results}

    # Merge index scores with ERP data
    suggestions = []
    for idx_r in index_results:
        erp_data = erp_lookup.get(idx_r['item_code'])
        if not erp_data:
            continue

        # Add scoring and highlight data
        erp_data['_similarity_score'] = idx_r['score']
        erp_data['_matched_params'] = idx_r.get('matched_params', {})
        erp_data['_param_highlights'] = get_match_highlights(
            params, erp_data.get('Omschrijving', ''), category
        )
        suggestions.append(erp_data)

    if not suggestions:
        logger.info(f"Row {row_index}: PARAM no ERP-verified results for {params}")
        return None  # Signal to fall back

    # Determine confidence based on score
    top_score = suggestions[0].get('_similarity_score', 0)
    if top_score >= 80:
        confidence = 'high'
    elif top_score >= 50:
        confidence = 'medium'
    else:
        confidence = 'low'

    auto = suggestions[0]
    logger.info(
        f"Row {row_index}: PARAM '{description[:40]}' [{category}] "
        f"— {len(suggestions)} hits, top score={top_score:.0f}%, {confidence}"
    )

    return {
        'row_index': row_index,
        'search_method': 'parameterized',
        'suggestions': suggestions,
        'auto_selected': auto,
        'confidence': confidence,
        'category': category,
        'extracted_params': params
    }


def find_ipn_batch(
    bom_rows: List[Dict],
    column_mapping: Dict[str, str],
    mpnfree_flags: Optional[Dict[str, bool]] = None,
) -> List[Dict[str, Any]]:
    """
    Find IPN for all BOM rows in parallel.

    Args:
        bom_rows: List of BOM row dicts (original data)
        column_mapping: Maps standard names to actual column headers
        mpnfree_flags: Dict keyed by str(row_index) -> bool. MPNfree=True rows
                       use parameterized matching by description instead of MPN.

    Returns:
        List of result dicts per row
    """
    if mpnfree_flags is None:
        mpnfree_flags = {}

    mpn_col = column_mapping.get('MPN', '')
    desc_col = column_mapping.get('Description', '')
    ipn_col = column_mapping.get('FaberNr', '')
    mfr_col = column_mapping.get('Manufacturer', '')

    mpnfree_count = sum(1 for v in mpnfree_flags.values() if v)
    logger.info(f"Column mapping: MPN='{mpn_col}', Desc='{desc_col}', IPN='{ipn_col}', Mfr='{mfr_col}'")
    logger.info(f"MPNfree rows: {mpnfree_count}")

    # Phase 1: Categorize rows
    mpn_rows = []       # (row_index, mpn, manufacturer)
    ipn_rows = []       # (row_index, ipn)
    param_rows = []     # (row_index, description, category) — parameterized matching
    desc_rows = []      # (row_index, description) — need AI search terms

    for i, row in enumerate(bom_rows):
        mpn = row.get(mpn_col, '').strip() if mpn_col else ''
        ipn = row.get(ipn_col, '').strip() if ipn_col else ''
        desc = row.get(desc_col, '').strip() if desc_col else ''
        mfr = row.get(mfr_col, '').strip() if mfr_col else ''
        is_mpnfree = mpnfree_flags.get(str(i), False)

        # MPNfree rows: parameterized search by description (skip MPN matching)
        if is_mpnfree and desc:
            category = detect_category(desc)
            if category and is_generic_rc(category):
                param_rows.append((i, desc, category))
                logger.debug(f"Row {i}: path=PARAM (MPNfree), category='{category}', desc='{desc[:60]}'")
                continue
            # MPNfree but not a recognized R/C category — fall through to description search
            desc_rows.append((i, desc))
            logger.debug(f"Row {i}: path=DESC (MPNfree, unknown category), desc='{desc[:80]}'")
            continue

        if mpn:
            mpn_rows.append((i, mpn, mfr))
            logger.debug(f"Row {i}: path=MPN, mpn='{mpn}', mfr='{mfr}'")
        elif ipn:
            ipn_rows.append((i, ipn))
            logger.debug(f"Row {i}: path=IPN, ipn='{ipn}'")
        elif desc:
            desc_rows.append((i, desc))
            logger.debug(f"Row {i}: path=DESC, desc='{desc[:80]}'")
        else:
            logger.debug(f"Row {i}: path=SKIP (no MPN/IPN/Description)")

    logger.info(
        f"Categorized {len(bom_rows)} rows: {len(mpn_rows)} MPN, "
        f"{len(ipn_rows)} IPN, {len(param_rows)} parameterized, "
        f"{len(desc_rows)} description-only"
    )

    # Phase 2: Generate AI search terms for description-only rows
    desc_search_terms = {}
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
    # Track parameterized rows that need fallback
    param_fallback_rows = []

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {}

        # Submit MPN searches
        for row_idx, mpn, mfr in mpn_rows:
            f = executor.submit(_search_row_by_mpn, row_idx, mpn, mfr)
            futures[f] = ('mpn', row_idx)

        # Submit IPN verify searches
        for row_idx, ipn in ipn_rows:
            f = executor.submit(_search_row_by_ipn, row_idx, ipn)
            futures[f] = ('ipn', row_idx)

        # Submit parameterized searches
        for row_idx, desc, category in param_rows:
            f = executor.submit(_search_row_by_parameters, row_idx, desc, category)
            futures[f] = ('param', row_idx)

        # Submit description searches
        for row_idx, desc in desc_rows:
            terms = desc_search_terms.get(row_idx, [])
            if terms:
                f = executor.submit(_search_row_by_description, row_idx, terms)
                futures[f] = ('desc', row_idx)
            else:
                words = desc.split()[:4]
                if words:
                    f = executor.submit(_search_row_by_description, row_idx, words)
                    futures[f] = ('desc', row_idx)

        # Collect results
        for future in as_completed(futures):
            search_type, row_idx = futures[future]
            try:
                result = future.result()
                if search_type == 'param' and result is None:
                    # Parameterized search returned None → needs fallback
                    param_fallback_rows.append(row_idx)
                else:
                    results[row_idx] = result
            except Exception as e:
                logger.error(f"Row {row_idx}: FAILED ({search_type}) — {e}")
                results[row_idx] = {
                    'row_index': row_idx,
                    'search_method': 'error',
                    'suggestions': [],
                    'auto_selected': None,
                    'confidence': 'none'
                }

    # Phase 4: Fallback for parameterized rows that yielded no results
    if param_fallback_rows:
        logger.info(f"Parameterized fallback needed for {len(param_fallback_rows)} rows")
        for row_idx in param_fallback_rows:
            # Find the original description
            desc = bom_rows[row_idx].get(desc_col, '').strip() if desc_col else ''
            if desc:
                words = desc.split()[:4]
                if words:
                    results[row_idx] = _search_row_by_description(row_idx, words)
                    continue
            results[row_idx] = {
                'row_index': row_idx,
                'search_method': 'skipped',
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


def find_ipn_single(
    row_index: int,
    row: Dict,
    column_mapping: Dict[str, str],
    is_mpnfree: bool = False,
) -> Dict[str, Any]:
    """Re-search a single row."""
    mpn_col = column_mapping.get('MPN', '')
    desc_col = column_mapping.get('Description', '')
    ipn_col = column_mapping.get('FaberNr', '')
    mfr_col = column_mapping.get('Manufacturer', '')

    mpn = row.get(mpn_col, '').strip() if mpn_col else ''
    ipn = row.get(ipn_col, '').strip() if ipn_col else ''
    desc = row.get(desc_col, '').strip() if desc_col else ''
    mfr = row.get(mfr_col, '').strip() if mfr_col else ''

    logger.info(f"Re-search row {row_index}: MPN='{mpn}', IPN='{ipn}', mpnfree={is_mpnfree}")

    # MPNfree rows: parameterized search by description
    if is_mpnfree and desc:
        category = detect_category(desc)
        if category and is_generic_rc(category):
            result = _search_row_by_parameters(row_index, desc, category)
            if result is not None:
                return result

    if mpn and not is_mpnfree:
        return _search_row_by_mpn(row_index, mpn, mfr)
    elif ipn:
        return _search_row_by_ipn(row_index, ipn)
    elif desc:
        # Fall back to AI search terms
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
