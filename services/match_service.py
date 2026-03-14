"""
BOM Matcher - Match Service
Parallel orchestrator for finding IPNs in Exact Globe.
Uses ThreadPoolExecutor for concurrent DB queries.
Supports parameterized matching for resistors/capacitors via SQLite index.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from typing import List, Dict, Any, Optional

from services import search_service
from services.mpn_normalize_service import search_with_variants_batched
from services.category_detect_service import detect_category, is_generic_rc
from services.category_index_service import search_by_parameters
from services.param_extract_service import (
    extract_parameters, get_match_highlights, get_mpn_highlights
)
from services.klant_cache_service import find_klant_nr_by_name

logger = logging.getLogger(__name__)

# KlantNr for ICP Systems B.V. — resolved lazily on first use
_icp_klant_nr: Optional[str] = None


def _get_icp_klant_nr() -> str:
    """Get the KlantNr for ICP Systems B.V., cached after first lookup."""
    global _icp_klant_nr
    if _icp_klant_nr is None:
        _icp_klant_nr = find_klant_nr_by_name("ICP Systems") or ""
    return _icp_klant_nr


def _filter_customer_specific(
    suggestions: List[Dict[str, Any]],
    selected_klant_nr: str = "",
) -> List[Dict[str, Any]]:
    """Filter out customer-specific IPNs that don't match the selected customer.

    Rules:
    - IPNs starting with '7': customer-specific, exclude unless KlantNr matches
    - IPNs starting with '500': ICP Systems B.V. specific, exclude unless ICP is selected
    """
    if not suggestions:
        return suggestions

    icp_nr = _get_icp_klant_nr()
    filtered = []

    for s in suggestions:
        ipn = str(s.get('FaberNr', '')).strip()
        klant_nr = str(s.get('KlantNr', '')).strip()

        if ipn.startswith('7'):
            # Customer-specific: only include if customer matches
            if selected_klant_nr and klant_nr == selected_klant_nr:
                filtered.append(s)
        elif ipn.startswith('500'):
            # ICP-specific: only include if ICP is the selected customer
            if selected_klant_nr and icp_nr and selected_klant_nr == icp_nr:
                filtered.append(s)
        else:
            filtered.append(s)

    return filtered


def _rank_suggestions(
    suggestions: List[Dict[str, Any]],
    selected_klant_nr: str = "",
) -> List[Dict[str, Any]]:
    """Filter customer-specific IPNs, then rank by score tier, stock, and cost.

    Decision tree:
    1. Filter out customer-specific IPNs (7xx, 500xx) that don't match
    2. Non-Vervallen before Vervallen (last resort)
    3. Score tier: ≥90% > ≥70% > <70% (higher tier always wins regardless of stock/cost)
    4. Within cost budget + in-stock preferred (budget = cheapest ±€0.02 or ±10%)
    5. In-stock (Voorraad > 0) before out-of-stock
    6. Lowest Kostprijs first
    7. Highest similarity score as final tiebreaker
    """
    suggestions = _filter_customer_specific(suggestions, selected_klant_nr)

    if not suggestions or len(suggestions) <= 1:
        return suggestions

    # Find cheapest cost among non-Vervallen candidates
    active_costs = [
        s.get('Kostprijs', 0) or 0
        for s in suggestions
        if s.get('Status', '') != 'Vervallen'
    ]
    cheapest = min(active_costs) if active_costs else 0

    def within_budget(kostprijs):
        if cheapest <= 0:
            return True
        return abs(kostprijs - cheapest) <= 0.02 or kostprijs <= cheapest * 1.10

    def sort_key(s):
        is_vervallen = 1 if s.get('Status', '') == 'Vervallen' else 0
        score = s.get('_similarity_score', 0) or 0
        score_tier = 0 if score >= 95 else (1 if score >= 70 else 2)
        has_stock = 1 if (s.get('Voorraad', 0) or 0) > 0 else 0
        kostprijs = s.get('Kostprijs', 0) or 0
        in_budget_and_stocked = 1 if (within_budget(kostprijs) and has_stock and not is_vervallen) else 0
        return (is_vervallen, score_tier, -in_budget_and_stocked, -has_stock, kostprijs, -score)

    return sorted(suggestions, key=sort_key)


def _search_row_by_mpn(row_index: int, mpn: str, manufacturer: str = "", selected_klant_nr: str = "") -> Dict[str, Any]:
    """Search a single row by MPN with variants, boosted by manufacturer."""
    results = search_with_variants_batched(
        mpn,
        lambda variants: search_service.search_by_mpn_variants(variants, manufacturer)
    )

    # Add MPN highlights for each suggestion
    for s in results[:20]:
        s['_mpn_highlights'] = get_mpn_highlights(mpn, s.get('Omschrijving', ''))

    ranked = _rank_suggestions(results[:20], selected_klant_nr)
    confidence = 'high' if ranked and ranked[0].get('_exact_match') else ('medium' if ranked else 'none')
    auto = ranked[0] if ranked else None
    auto_str = f" → {auto['FaberNr']}" if auto else ""
    logger.info(f"Row {row_index}: MPN '{mpn}' — {len(results)} hits, {confidence}{auto_str}")

    return {
        'row_index': row_index,
        'search_method': 'mpn',
        'suggestions': ranked,
        'auto_selected': auto,
        'confidence': confidence
    }


def _search_row_by_ipn(row_index: int, ipn: str, selected_klant_nr: str = "") -> Dict[str, Any]:
    """Verify/search a single row by existing IPN."""
    results = search_service.search_by_ipn(ipn)
    exact = [r for r in results if r.get('FaberNr', '').strip() == ipn.strip()]
    confidence = 'high' if exact else ('medium' if results else 'none')
    ranked = _rank_suggestions(exact if exact else results, selected_klant_nr)
    auto = ranked[0] if ranked else None
    auto_str = f" → {auto['FaberNr']}" if auto else ""
    logger.info(f"Row {row_index}: IPN '{ipn}' — {len(results)} hits, {len(exact)} exact, {confidence}{auto_str}")
    return {
        'row_index': row_index,
        'search_method': 'ipn_verify',
        'suggestions': _rank_suggestions(results, selected_klant_nr),
        'auto_selected': auto,
        'confidence': confidence
    }


def _search_row_by_description(row_index: int, search_terms: List[str], selected_klant_nr: str = "") -> Dict[str, Any]:
    """Search a single row by description terms."""
    results = search_service.search_by_description(search_terms)
    ranked = _rank_suggestions(results[:20], selected_klant_nr)
    confidence = 'low' if ranked else 'none'
    auto = ranked[0] if ranked else None
    auto_str = f" → {auto['FaberNr']}" if auto else ""
    logger.info(f"Row {row_index}: DESC {search_terms} — {len(results)} hits, {confidence}{auto_str}")
    return {
        'row_index': row_index,
        'search_method': 'description',
        'suggestions': ranked,
        'auto_selected': auto,
        'confidence': confidence
    }


def _search_row_by_parameters(row_index: int, description: str, category: str, selected_klant_nr: str = "") -> Dict[str, Any]:
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
        erp_data['_bom_highlights'] = get_match_highlights(
            params, description, category
        )
        suggestions.append(erp_data)

    if not suggestions:
        logger.info(f"Row {row_index}: PARAM no ERP-verified results for {params}")
        return None  # Signal to fall back

    # Rank by status/stock/cost, then pick best
    ranked = _rank_suggestions(suggestions, selected_klant_nr)

    # Determine confidence based on top score
    top_score = ranked[0].get('_similarity_score', 0)
    if top_score >= 80:
        confidence = 'high'
    elif top_score >= 50:
        confidence = 'medium'
    else:
        confidence = 'low'

    # Only auto-select if score is good enough
    auto = ranked[0] if top_score >= 60 else None
    logger.info(
        f"Row {row_index}: PARAM '{description[:40]}' [{category}] "
        f"— {len(ranked)} hits, top score={top_score:.0f}%, {confidence}"
    )

    return {
        'row_index': row_index,
        'search_method': 'parameterized',
        'suggestions': ranked,
        'auto_selected': auto,
        'confidence': confidence,
        'category': category,
        'extracted_params': params
    }


def find_ipn_batch(
    bom_rows: List[Dict],
    column_mapping: Dict[str, str],
    mpnfree_flags: Optional[Dict[str, bool]] = None,
    selected_klant_nr: str = "",
) -> List[Dict[str, Any]]:
    """
    Find IPN for all BOM rows in parallel.

    Args:
        bom_rows: List of BOM row dicts (original data)
        column_mapping: Maps standard names to actual column headers
        mpnfree_flags: Dict keyed by str(row_index) -> bool. MPNfree=True rows
                       use parameterized matching by description instead of MPN.
        selected_klant_nr: Selected customer KlantNr for filtering customer-specific IPNs.

    Returns:
        List of result dicts per row
    """
    if mpnfree_flags is None:
        mpnfree_flags = {}

    # Clear search cache for fresh batch results
    search_service.clear_search_cache()

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

    # Parallel search
    results = [None] * len(bom_rows)
    completed = 0

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {}

        # Submit MPN searches
        for row_idx, mpn, mfr in mpn_rows:
            f = executor.submit(_search_row_by_mpn, row_idx, mpn, mfr, selected_klant_nr)
            futures[f] = ('mpn', row_idx)

        # Submit IPN verify searches
        for row_idx, ipn in ipn_rows:
            f = executor.submit(_search_row_by_ipn, row_idx, ipn, selected_klant_nr)
            futures[f] = ('ipn', row_idx)

        # Submit parameterized searches
        for row_idx, desc, category in param_rows:
            f = executor.submit(_search_row_by_parameters, row_idx, desc, category, selected_klant_nr)
            futures[f] = ('param', row_idx)

        # Submit description searches (word-split)
        for row_idx, desc in desc_rows:
            words = desc.split()[:4]
            if words:
                f = executor.submit(_search_row_by_description, row_idx, words, selected_klant_nr)
                futures[f] = ('desc', row_idx)

        total_searches = len(futures)
        logger.info(f"Parallel search started: {total_searches} tasks across 4 workers "
                     f"({len(mpn_rows)} MPN, {len(ipn_rows)} IPN, {len(param_rows)} param, "
                     f"{len(desc_rows)} desc)")

        # Collect results — dynamically submit param fallbacks
        while futures:
            done, _ = wait(futures.keys(), return_when=FIRST_COMPLETED)
            for future in done:
                search_type, row_idx = futures.pop(future)
                completed += 1
                try:
                    result = future.result()

                    if search_type == 'param' and result is None:
                        # Parameterized search returned None → fallback to description search
                        desc = bom_rows[row_idx].get(desc_col, '').strip() if desc_col else ''
                        if desc:
                            words = desc.split()[:4]
                            if words:
                                f = executor.submit(_search_row_by_description, row_idx, words, selected_klant_nr)
                                futures[f] = ('desc', row_idx)
                                logger.info(f"  Row {row_idx+1}: PARAM fallback → description search")
                                continue
                        results[row_idx] = {
                            'row_index': row_idx,
                            'search_method': 'skipped',
                            'suggestions': [],
                            'auto_selected': None,
                            'confidence': 'none'
                        }

                    else:
                        conf = result.get('confidence', 'none') if result else 'none'
                        hits = len(result.get('suggestions', [])) if result else 0
                        logger.info(f"  [{completed}] Row {row_idx+1}: {search_type.upper()} — {hits} hits, {conf}")
                        results[row_idx] = result

                except Exception as e:
                    logger.error(f"  Row {row_idx+1}: FAILED ({search_type}) — {e}")
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


def find_ipn_single(
    row_index: int,
    row: Dict,
    column_mapping: Dict[str, str],
    is_mpnfree: bool = False,
    selected_klant_nr: str = "",
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
            result = _search_row_by_parameters(row_index, desc, category, selected_klant_nr)
            if result is not None:
                return result

    if mpn and not is_mpnfree:
        return _search_row_by_mpn(row_index, mpn, mfr, selected_klant_nr)
    elif ipn:
        return _search_row_by_ipn(row_index, ipn, selected_klant_nr)
    elif desc:
        words = desc.split()[:4]
        if words:
            return _search_row_by_description(row_index, words, selected_klant_nr)

    return {
        'row_index': row_index,
        'search_method': 'skipped',
        'suggestions': [],
        'auto_selected': None,
        'confidence': 'none'
    }
