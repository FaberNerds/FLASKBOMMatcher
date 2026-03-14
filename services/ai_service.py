"""
BOM Matcher - MPNfree Assessment Service
Rule-based MPNfree classification using category detection.
"""
import logging

logger = logging.getLogger(__name__)


def assess_mpnfree_batch_local(rows: list[dict]) -> list[dict]:
    """Rule-based MPNfree classification.

    Uses the existing category_detect_service to classify components instantly.
    """
    from services.category_detect_service import detect_category, is_generic_rc

    results = []
    for row in rows:
        desc = row.get('description', '')
        mpn = row.get('mpn', '')
        mfr = row.get('manufacturer', '')
        idx = row['index']

        category = detect_category(desc)
        if category:
            is_free = is_generic_rc(category)
            results.append({
                'index': idx,
                'mpnfree': is_free,
                'reason': f'Rule: {category}'
            })
        elif mpn and mfr:
            results.append({
                'index': idx,
                'mpnfree': False,
                'reason': 'Has specific MPN and manufacturer'
            })
        else:
            results.append({
                'index': idx,
                'mpnfree': False,
                'reason': 'Unrecognized component'
            })

    logger.info(f"MPNfree local assessment: {len(rows)} rows, "
                f"{sum(1 for r in results if r['mpnfree'])} marked MPNfree")
    return results
