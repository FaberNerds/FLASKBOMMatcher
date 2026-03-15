"""
BOM Matcher - MPN Normalize Service
Generates MPN variants for fuzzy matching against Exact DB.
"""
import re
import logging
from typing import List, Dict, Any, Callable

logger = logging.getLogger(__name__)


def generate_mpn_variants(mpn: str) -> List[str]:
    """
    Generate search variants for an MPN.
    Returns a list of MPN strings to try, most specific first.
    """
    if not mpn or not mpn.strip():
        return []

    mpn = mpn.strip()
    variants = [mpn]  # Original always first

    # Strip/add TR suffix (tape-and-reel)
    if mpn.upper().endswith('TR'):
        base = mpn[:-2].rstrip('-').rstrip()
        if base and base not in variants:
            variants.append(base)
    else:
        tr_variant = mpn + 'TR'
        if tr_variant not in variants:
            variants.append(tr_variant)

    # Strip reel size suffixes: ,115  ,215  -115  -215
    reel_pattern = re.compile(r'[,\-](115|215|118|218)$', re.IGNORECASE)
    match = reel_pattern.search(mpn)
    if match:
        base = mpn[:match.start()]
        if base and base not in variants:
            variants.append(base)
    else:
        # Try adding common reel suffixes
        for suffix in [',115', ',215']:
            v = mpn + suffix
            if v not in variants:
                variants.append(v)

    # Strip distributor suffixes: -ND, -CT, -1-ND
    dist_pattern = re.compile(r'[\-](ND|CT|1-ND|DKR|TR-ND)$', re.IGNORECASE)
    match = dist_pattern.search(mpn)
    if match:
        base = mpn[:match.start()]
        if base and base not in variants:
            variants.append(base)

    # Handle dash/space variations
    if '-' in mpn:
        no_dash = mpn.replace('-', '')
        if no_dash not in variants:
            variants.append(no_dash)
    if ' ' in mpn:
        no_space = mpn.replace(' ', '')
        if no_space not in variants:
            variants.append(no_space)

    # Remove ALL whitespace (handles tabs, spaces around parentheses, etc.)
    no_ws = re.sub(r'\s+', '', mpn)
    if no_ws not in variants:
        variants.append(no_ws)

    # Normalize whitespace around parentheses/brackets
    normalized_parens = re.sub(r'\s*([()])\s*', r'\1', mpn)
    if normalized_parens not in variants:
        variants.append(normalized_parens)

    # Add space before opening parentheses (catches ERP entries with spaces before parens)
    with_paren_space = re.sub(r'([^\s])\(', r'\1 (', mpn)
    if with_paren_space not in variants:
        variants.append(with_paren_space)

    # Strip parenthesized content for broader matching (e.g., "SM02B-SRSS-TB(LF)(SN)" → "SM02B-SRSS-TB")
    paren_idx = mpn.find('(')
    if paren_idx > 0:
        base_before_parens = mpn[:paren_idx].rstrip()
        if base_before_parens and len(base_before_parens) >= 5 and base_before_parens not in variants:
            variants.append(base_before_parens)

    # Strip trailing dash + short suffix (package/version codes like -7, -13, -4, -7B)
    # Known suffixes (TR, ND, CT, etc.) are already handled above
    _known_suffixes = {'TR', 'ND', 'CT', 'DKR'}
    trailing_match = re.match(r'^(.+?)-([A-Za-z0-9]{1,4})$', mpn)
    if trailing_match:
        base = trailing_match.group(1)
        suffix = trailing_match.group(2).upper()
        if base and len(base) >= 5 and suffix not in _known_suffixes:
            if base not in variants:
                variants.append(base)

    return variants


def search_with_variants(
    mpn: str,
    search_fn: Callable[[str], List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """
    Search all MPN variants, deduplicate by FaberNr, return ranked results.
    Results from earlier (more specific) variants are ranked higher.
    """
    variants = generate_mpn_variants(mpn)
    logger.debug(f"MPN variants for '{mpn}': {variants}")
    seen_fabernr = set()
    results = []

    for variant in variants:
        try:
            hits = search_fn(variant)
            new_hits = [h for h in hits if h.get('FaberNr', '') and h.get('FaberNr', '') not in seen_fabernr]
            logger.debug(f"Variant '{variant}': {len(hits)} hits, {len(new_hits)} new unique")
            for hit in hits:
                fnr = hit.get('FaberNr', '')
                if fnr and fnr not in seen_fabernr:
                    seen_fabernr.add(fnr)
                    hit['_search_variant'] = variant
                    hit['_exact_match'] = (variant.upper() == mpn.upper())
                    results.append(hit)
        except Exception as e:
            logger.warning(f"Variant search failed for '{variant}': {e}")

    logger.info(f"'{mpn}' → {len(results)} unique results ({len(variants)} variants tried)")
    return results


def _normalize_for_comparison(s: str) -> str:
    """Strip all whitespace and normalize to uppercase for comparison."""
    return re.sub(r'\s+', '', s).upper()


def search_with_variants_batched(
    mpn: str,
    batch_search_fn: Callable[[List[str]], List[Dict[str, Any]]]
) -> List[Dict[str, Any]]:
    """
    Search all MPN variants in a single batched query, then deduplicate and rank.

    Unlike search_with_variants which makes one DB call per variant,
    this calls batch_search_fn once with all variants, then post-processes
    to rank results by variant specificity (exact match first).
    """
    variants = generate_mpn_variants(mpn)
    if not variants:
        return []

    logger.debug(f"MPN batched variants for '{mpn}': {variants}")

    try:
        all_hits = batch_search_fn(variants)
    except Exception as e:
        logger.warning(f"Batched variant search failed for '{mpn}': {e}")
        return []

    # Deduplicate by FaberNr and tag with variant/exact_match info
    mpn_upper = mpn.upper()
    mpn_normalized = _normalize_for_comparison(mpn)
    seen_fabernr = set()
    results = []

    for hit in all_hits:
        fnr = hit.get('FaberNr', '')
        if not fnr or fnr in seen_fabernr:
            continue
        seen_fabernr.add(fnr)

        # Determine which variant matched this hit
        hit_mpn = (hit.get('MPN', '') or '').upper()
        hit_mpn_normalized = _normalize_for_comparison(hit.get('MPN', '') or '')
        matched_variant = mpn  # default
        is_exact = False
        for variant in variants:
            if variant.upper() in hit_mpn:
                matched_variant = variant
                if variant.upper() == mpn_upper:
                    is_exact = True
                break

        # Also treat as exact if the normalized MPNs match
        # (handles whitespace-only differences like "TB(LF)" vs "TB (LF)")
        if not is_exact and hit_mpn_normalized == mpn_normalized:
            is_exact = True

        hit['_search_variant'] = matched_variant
        hit['_exact_match'] = is_exact
        results.append(hit)

    # Sort: exact matches first, then by original result order
    results.sort(key=lambda r: (not r.get('_exact_match', False),))

    logger.info(f"'{mpn}' → {len(results)} unique results (batched, {len(variants)} variants)")
    return results
