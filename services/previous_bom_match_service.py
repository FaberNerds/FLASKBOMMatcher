"""
BOM Matcher - Previous BOM Match Service

Matches a newly uploaded BOM against a *previous-version* BOM fetched from Exact
(see exact_bom_service) instead of the live ERP catalog. The goal is to reuse the
exact Faber articles (FaberNr) that were already purchased for the prior revision,
so leftover/dead stock is avoided.

Strategy per new BOM row:
  1. MPN fuzzy match: normalize the MPN and gate on the first 5 chars, then rank the
     old-BOM candidates by string similarity. A hit is a confident match.
  2. Generic R/C parameter match: for resistors/capacitors/elcos with no MPN match,
     extract parameters and score against old-BOM generic parts of the same category,
     reusing the existing parameter scorer.
  3. No match -> left blank (auto_selected = None, confidence = 'none').

Matched FaberNrs are enriched once (batched) with live ERP data so the right panel
shows current stock/cost/status. Because the old BOM was fetched live from Exact,
every FaberNr should resolve; if enrichment can't find one, that row is left blank
(no stub data).
"""
import logging
import re
from difflib import SequenceMatcher
from typing import Dict, List, Any

from services.match_service import _get_mapped_value
from services.category_detect_service import detect_category, is_generic_rc
from services.param_extract_service import (
    extract_parameters, get_mpn_highlights, get_match_highlights,
)
from services.category_index_service import CATEGORY_WEIGHTS, CategoryIndex
from services import search_service

logger = logging.getLogger(__name__)

# Fuzzy MPN matching: require the first N normalized chars to be equal, then rank by
# full-string similarity. Captures "slight differences" (tape/reel, packaging suffixes).
MPN_PREFIX_LEN = 5

# Parameter-match confidence thresholds (mirror match_service._search_row_by_parameters).
PARAM_HIGH = 80
PARAM_MEDIUM = 50

# Cap suggestions per row to keep payloads reasonable.
MAX_SUGGESTIONS = 20


def _norm_mpn(mpn: str) -> str:
    """Normalize an MPN: uppercase, strip everything but letters/digits."""
    return re.sub(r'[^A-Z0-9]', '', (mpn or '').upper())


def _prepare_old_parts(previous_bom: List[Dict]) -> List[Dict]:
    """Pre-index old-BOM components with normalized MPN, category, and params."""
    parts: List[Dict] = []
    for comp in previous_bom or []:
        fn = str(comp.get('FaberNr', '')).strip()
        if not fn:
            continue
        desc = comp.get('Description', '') or ''
        cat = detect_category(desc)
        generic = bool(cat and is_generic_rc(cat))
        cat_key = cat.upper() if cat else ''
        params = extract_parameters(desc, cat) if generic else {}
        parts.append({
            'FaberNr': fn,
            'MPN': comp.get('MPN', '') or '',
            'norm_mpn': _norm_mpn(comp.get('MPN', '')),
            'Manufacturer': comp.get('Manufacturer', '') or '',
            'Description': desc,
            'category': cat,
            'cat_key': cat_key,
            'generic': generic,
            'params': params,
        })
    return parts


def _mpn_candidates(norm_mpn: str, manufacturer: str, old_parts: List[Dict]) -> List[tuple]:
    """Return [(FaberNr, score_0_100)] for old parts whose MPN fuzzy-matches.

    Gate: first MPN_PREFIX_LEN normalized chars equal (or the shorter is a prefix of
    the longer when either is shorter than the gate). Ranked by SequenceMatcher ratio,
    with a small boost when the manufacturer also matches.
    """
    if not norm_mpn:
        return []
    gate = norm_mpn[:MPN_PREFIX_LEN]
    mfr_up = (manufacturer or '').upper().strip()

    best: Dict[str, float] = {}
    for p in old_parts:
        op = p['norm_mpn']
        if not op:
            continue
        if len(norm_mpn) < MPN_PREFIX_LEN or len(op) < MPN_PREFIX_LEN:
            if not (op.startswith(norm_mpn) or norm_mpn.startswith(op)):
                continue
        elif op[:MPN_PREFIX_LEN] != gate:
            continue

        ratio = SequenceMatcher(None, norm_mpn, op).ratio()
        if mfr_up and p['Manufacturer'] and mfr_up in p['Manufacturer'].upper():
            ratio = min(1.0, ratio + 0.05)

        fn = p['FaberNr']
        if fn not in best or ratio > best[fn]:
            best[fn] = ratio

    ranked = sorted(best.items(), key=lambda x: x[1], reverse=True)
    return [(fn, round(score * 100, 1)) for fn, score in ranked[:MAX_SUGGESTIONS]]


def _param_candidates(cat_key: str, q_params: Dict[str, str], old_parts: List[Dict]) -> List[tuple]:
    """Return [(FaberNr, score_0_100)] for old generic parts of the same category."""
    weights = CATEGORY_WEIGHTS.get(cat_key, {})
    if not weights:
        n = len(q_params) or 1
        weights = {p: 100 // n for p in q_params}

    best: Dict[str, float] = {}
    for p in old_parts:
        if not p['generic'] or p['cat_key'] != cat_key or not p['params']:
            continue
        score, _matched = CategoryIndex._compute_score(q_params, p['params'], weights, cat_key)
        if score > 0:
            fn = p['FaberNr']
            if fn not in best or score > best[fn]:
                best[fn] = score

    ranked = sorted(best.items(), key=lambda x: x[1], reverse=True)
    return [(fn, round(score, 2)) for fn, score in ranked[:MAX_SUGGESTIONS]]


def _match_one(mpn: str, desc: str, mfr: str, old_parts: List[Dict]) -> Dict[str, Any]:
    """Determine candidate matches for one new row (before live enrichment)."""
    norm_mpn = _norm_mpn(mpn)
    if norm_mpn:
        cands = _mpn_candidates(norm_mpn, mfr, old_parts)
        if cands:
            return {'method': 'previous_mpn', 'category': '', 'q_params': {},
                    'mpn': mpn, 'cands': cands}

    cat = detect_category(desc)
    if cat and is_generic_rc(cat):
        cat_key = cat.upper()
        q_params = extract_parameters(desc, cat)
        if q_params:
            cands = _param_candidates(cat_key, q_params, old_parts)
            if cands:
                return {'method': 'previous_param', 'category': cat, 'q_params': q_params,
                        'mpn': mpn, 'cands': cands}

    return {'method': 'previous_none', 'category': '', 'q_params': {}, 'mpn': mpn, 'cands': []}


def _blank_result(row_index: int) -> Dict[str, Any]:
    return {
        'row_index': row_index,
        'search_method': 'previous_none',
        'suggestions': [],
        'auto_selected': None,
        'display_suggestion': None,
        'confidence': 'none',
    }


def _build_result(row_index: int, row: Dict, mapping: Dict, cand: Dict,
                  erp_lookup: Dict[str, Dict]) -> Dict[str, Any]:
    """Build a row result from candidates + live ERP enrichment."""
    if not cand['cands']:
        return _blank_result(row_index)

    method = cand['method']
    desc = _get_mapped_value(row, mapping, 'Description')
    mpn = cand.get('mpn', '')
    q_params = cand.get('q_params', {})
    category = cand.get('category', '')

    suggestions: List[Dict] = []
    for fn, score in cand['cands']:
        erp = erp_lookup.get(fn)
        if not erp:
            continue  # No stub fallback — old BOM came live from Exact, so this is rare.
        s = dict(erp)
        s['_similarity_score'] = score
        if method == 'previous_param':
            s['_param_highlights'] = get_match_highlights(q_params, s.get('Omschrijving', ''), category)
            s['_bom_highlights'] = get_match_highlights(q_params, desc, category)
        if mpn:
            s['_mpn_highlights'] = get_mpn_highlights(mpn, s.get('Omschrijving', ''))
        suggestions.append(s)

    if not suggestions:
        return _blank_result(row_index)

    result = {
        'row_index': row_index,
        'search_method': method,
        'suggestions': suggestions,
        'auto_selected': None,
        'display_suggestion': None,
        'confidence': 'none',
        'category': category,
        'extracted_params': q_params,
    }
    top = suggestions[0]

    if method == 'previous_mpn':
        # A 5-char-gated MPN match against the old BOM is a confident reuse.
        result['confidence'] = 'high'
        result['auto_selected'] = top
        result['display_suggestion'] = top
    else:  # previous_param
        top_score = top.get('_similarity_score', 0)
        if top_score >= PARAM_HIGH:
            result['confidence'] = 'high'
            result['auto_selected'] = top
            result['display_suggestion'] = top
        elif top_score >= PARAM_MEDIUM:
            result['confidence'] = 'medium'
            result['display_suggestion'] = top
        # else: leave blank (confidence 'none'), but keep suggestions for manual review.

    return result


def match_against_previous_bom(
    new_rows: List[Dict],
    column_mapping: Dict[str, Any],
    previous_bom: List[Dict],
    selected_klant_nr: str = "",
) -> List[Dict[str, Any]]:
    """Match every new BOM row against the previous-version BOM.

    Returns a list of result dicts (same shape as match_service.find_ipn_batch).
    """
    old_parts = _prepare_old_parts(previous_bom)
    logger.info(
        f"Previous-BOM match: {len(new_rows)} new rows vs {len(old_parts)} old parts "
        f"({sum(1 for p in old_parts if p['generic'])} generic R/C)"
    )

    # Phase 1: determine candidate FaberNrs per row.
    row_candidates: Dict[int, Dict] = {}
    all_fabernrs = set()
    for i, row in enumerate(new_rows):
        mpn = _get_mapped_value(row, column_mapping, 'MPN')
        desc = _get_mapped_value(row, column_mapping, 'Description')
        mfr = _get_mapped_value(row, column_mapping, 'Manufacturer')
        cand = _match_one(mpn, desc, mfr, old_parts)
        row_candidates[i] = cand
        for fn, _score in cand['cands']:
            all_fabernrs.add(fn)

    # Phase 2: one batched live ERP enrichment for all candidate FaberNrs.
    erp_lookup: Dict[str, Dict] = {}
    if all_fabernrs:
        erp_rows = search_service.search_by_item_codes(list(all_fabernrs))
        erp_lookup = {str(r.get('FaberNr', '')).strip(): r for r in erp_rows}

    # Phase 3: build per-row results.
    results = [
        _build_result(i, row, column_mapping, row_candidates[i], erp_lookup)
        for i, row in enumerate(new_rows)
    ]

    matched = sum(1 for r in results if r['confidence'] != 'none')
    logger.info(f"Previous-BOM match done: {matched}/{len(results)} rows matched")
    return results


def match_previous_single(
    row_index: int,
    row: Dict,
    column_mapping: Dict[str, Any],
    previous_bom: List[Dict],
    selected_klant_nr: str = "",
) -> Dict[str, Any]:
    """Re-match a single new row against the previous-version BOM."""
    old_parts = _prepare_old_parts(previous_bom)
    mpn = _get_mapped_value(row, column_mapping, 'MPN')
    desc = _get_mapped_value(row, column_mapping, 'Description')
    mfr = _get_mapped_value(row, column_mapping, 'Manufacturer')

    cand = _match_one(mpn, desc, mfr, old_parts)
    fabernrs = [fn for fn, _score in cand['cands']]
    erp_lookup: Dict[str, Dict] = {}
    if fabernrs:
        erp_rows = search_service.search_by_item_codes(fabernrs)
        erp_lookup = {str(r.get('FaberNr', '')).strip(): r for r in erp_rows}

    return _build_result(row_index, row, column_mapping, cand, erp_lookup)
