"""
Category detection service for BOM Matcher.
Rule-based detection of ERP component categories from customer BOM descriptions.
No AI involved - pure regex and keyword matching.
"""

import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# --- Known ERP categories (Exact Globe, Dutch) ---

KNOWN_CATEGORIES = [
    "WEERSTANDEN",
    "CONDENSATOREN",
    "INTEGRATED CIRCUITS",
    "CONNECTOREN/PLUGGEN",
    "DIODEN EN DIAC'S",
    "TRANSISTOREN en FETS",
    "SPOELEN en SUPPRESSORS",
    "ELCO'S en TANTALEN",
    "LED / OPTO'S",
    "SPANNINGSREGELAARS",
    "SCHAKEL. en DRUKKN.",
    "ZEKERINGEN en HOUDERS",
    "KRISTALLEN en OSCILLATOREN",
    "BEVESTIGINGSMATERIAAL",
    "RELAIS en VOETEN",
]

GENERIC_RC_CATEGORIES = {"WEERSTANDEN", "CONDENSATOREN", "ELCO'S en TANTALEN"}

# --- Compiled patterns ---

# Priority 1: Unit-value patterns
_PAT_FARAD = re.compile(r'\d+[pnuµ]F', re.IGNORECASE)
_PAT_ELCO_TANT = re.compile(r'elco|tant', re.IGNORECASE)
_PAT_OHM = re.compile(r'\d+[kKMmR\u03A9]?\s*[oO]hm', re.IGNORECASE)
_PAT_E_NOTATION = re.compile(r'\b\d+[EeRr]\d+\b')
_PAT_RESISTANCE_KM = re.compile(r'\b\d+[kKM](?:\d+)?(?:\s|$)')
_PAT_RESISTANCE_CONTEXT = re.compile(r'resist|weerstand|ohm|%\s*tol|\bres\b', re.IGNORECASE)
_PAT_HENRY = re.compile(r'\d+[nuµm]H', re.IGNORECASE)
_PAT_HERTZ = re.compile(r'\d+(?:\.\d+)?\s*[kKMG]?Hz', re.IGNORECASE)

# Priority 2: Prefix keywords
_PREFIX_RULES = [
    (re.compile(r'^RES\b', re.IGNORECASE), "WEERSTANDEN"),
    (re.compile(r'^WEERSTAND', re.IGNORECASE), "WEERSTANDEN"),
    (re.compile(r'^CAP\b', re.IGNORECASE), "CONDENSATOREN"),
    (re.compile(r'^COND', re.IGNORECASE), "CONDENSATOREN"),
    (re.compile(r'^IC\b', re.IGNORECASE), "INTEGRATED CIRCUITS"),
    (re.compile(r'^CONN\b', re.IGNORECASE), "CONNECTOREN/PLUGGEN"),
    (re.compile(r'^PLUG', re.IGNORECASE), "CONNECTOREN/PLUGGEN"),
    (re.compile(r'^HEADER', re.IGNORECASE), "CONNECTOREN/PLUGGEN"),
    (re.compile(r'^SOCKET', re.IGNORECASE), "CONNECTOREN/PLUGGEN"),
    (re.compile(r'^DIODE', re.IGNORECASE), "DIODEN EN DIAC'S"),
    (re.compile(r'^ZDIODE', re.IGNORECASE), "DIODEN EN DIAC'S"),
    (re.compile(r'^SUPPRESSOR', re.IGNORECASE), "DIODEN EN DIAC'S"),
    (re.compile(r'^TVS', re.IGNORECASE), "DIODEN EN DIAC'S"),
    (re.compile(r'^SCHOTTKY', re.IGNORECASE), "DIODEN EN DIAC'S"),
    (re.compile(r'^FET\b', re.IGNORECASE), "TRANSISTOREN en FETS"),
    (re.compile(r'^MOSFET', re.IGNORECASE), "TRANSISTOREN en FETS"),
    (re.compile(r'^TRANS\b', re.IGNORECASE), "TRANSISTOREN en FETS"),
    (re.compile(r'^BJT', re.IGNORECASE), "TRANSISTOREN en FETS"),
    (re.compile(r'^SPOEL', re.IGNORECASE), "SPOELEN en SUPPRESSORS"),
    (re.compile(r'^FERRIET', re.IGNORECASE), "SPOELEN en SUPPRESSORS"),
    (re.compile(r'^INDUCTOR', re.IGNORECASE), "SPOELEN en SUPPRESSORS"),
    (re.compile(r'^ELCO', re.IGNORECASE), "ELCO'S en TANTALEN"),
    (re.compile(r'^TANT', re.IGNORECASE), "ELCO'S en TANTALEN"),
    (re.compile(r'^LED\b', re.IGNORECASE), "LED / OPTO'S"),
    (re.compile(r'^RELAIS', re.IGNORECASE), "RELAIS en VOETEN"),
]

# Priority 3: Keyword anywhere
_KEYWORD_RULES = [
    (re.compile(r'resistor|weerstand|ohm', re.IGNORECASE), "WEERSTANDEN"),
    (re.compile(r'capacitor|condensator|ceramic\s*cap', re.IGNORECASE), "CONDENSATOREN"),
    (re.compile(r'microcontroller|mcu|fpga|cpu|processor|op.?amp|comparator', re.IGNORECASE), "INTEGRATED CIRCUITS"),
    (re.compile(r'connector|header|socket|receptacle|plug|jack|usb|rj45|d-sub', re.IGNORECASE), "CONNECTOREN/PLUGGEN"),
    (re.compile(r'diode|rectifier|zener|schottky|tvs|esd|suppressor', re.IGNORECASE), "DIODEN EN DIAC'S"),
    (re.compile(r'transistor|mosfet|jfet|igbt', re.IGNORECASE), "TRANSISTOREN en FETS"),
    (re.compile(r'inductor|choke|ferrite|coil|spoel|ferriet', re.IGNORECASE), "SPOELEN en SUPPRESSORS"),
    (re.compile(r'electrolytic|tantalum|elco|tantaal', re.IGNORECASE), "ELCO'S en TANTALEN"),
    (re.compile(r'led|optocoupler|photo|opto', re.IGNORECASE), "LED / OPTO'S"),
    (re.compile(r'regulator|ldo|buck|boost|dc-dc|spanningsregelaar', re.IGNORECASE), "SPANNINGSREGELAARS"),
    (re.compile(r'switch|button|schakelaar|drukknop', re.IGNORECASE), "SCHAKEL. en DRUKKN."),
    (re.compile(r'fuse|zekering|polyfuse|ptc', re.IGNORECASE), "ZEKERINGEN en HOUDERS"),
    (re.compile(r'crystal|oscillator|kristal', re.IGNORECASE), "KRISTALLEN en OSCILLATOREN"),
    (re.compile(r'screw|nut|bolt|washer|standoff|spacer|bout|moer', re.IGNORECASE), "BEVESTIGINGSMATERIAAL"),
    (re.compile(r'relay|relais', re.IGNORECASE), "RELAIS en VOETEN"),
]

# Priority 4: Dielectric keywords (strong capacitor indicator)
_PAT_DIELECTRIC = re.compile(r'X7R|X5R|C0G|NP0|Y5V', re.IGNORECASE)


def detect_category(description: str) -> Optional[str]:
    """Detect ERP category from a customer BOM description string.

    Applies rule-based detection in priority order:
      1. Unit-value patterns (pF/nF/uF, ohm, nH/uH, Hz)
      2. Prefix keywords (RES, CAP, IC, ...)
      3. Keywords anywhere in the description
      4. Dielectric codes (X7R, NP0, ...)

    Returns the ERP category name or None if undetected.
    """
    if not description or not description.strip():
        return None

    desc = description.strip()

    # --- Priority 1: Unit-value patterns ---
    if _PAT_FARAD.search(desc):
        cat = "ELCO'S en TANTALEN" if _PAT_ELCO_TANT.search(desc) else "CONDENSATOREN"
        logger.debug("Category detected (unit-value farad): %s -> %s", desc, cat)
        return cat

    if _PAT_OHM.search(desc):
        logger.debug("Category detected (unit-value ohm): %s -> WEERSTANDEN", desc)
        return "WEERSTANDEN"

    if _PAT_E_NOTATION.search(desc) and _PAT_RESISTANCE_CONTEXT.search(desc):
        logger.debug("Category detected (E-notation resistor): %s -> WEERSTANDEN", desc)
        return "WEERSTANDEN"

    if _PAT_RESISTANCE_KM.search(desc) and _PAT_RESISTANCE_CONTEXT.search(desc):
        logger.debug("Category detected (kM resistor): %s -> WEERSTANDEN", desc)
        return "WEERSTANDEN"

    if _PAT_HENRY.search(desc):
        logger.debug("Category detected (unit-value henry): %s -> SPOELEN en SUPPRESSORS", desc)
        return "SPOELEN en SUPPRESSORS"

    if _PAT_HERTZ.search(desc):
        logger.debug("Category detected (unit-value hertz): %s -> KRISTALLEN en OSCILLATOREN", desc)
        return "KRISTALLEN en OSCILLATOREN"

    # --- Priority 2: Prefix keywords ---
    for pattern, cat in _PREFIX_RULES:
        if pattern.search(desc):
            logger.debug("Category detected (prefix): %s -> %s", desc, cat)
            return cat

    # --- Priority 3: Keyword anywhere ---
    for pattern, cat in _KEYWORD_RULES:
        if pattern.search(desc):
            logger.debug("Category detected (keyword): %s -> %s", desc, cat)
            return cat

    # --- Priority 4: Dielectric keywords ---
    if _PAT_DIELECTRIC.search(desc):
        logger.debug("Category detected (dielectric): %s -> CONDENSATOREN", desc)
        return "CONDENSATOREN"

    logger.debug("No category detected for: %s", desc)
    return None


def detect_category_from_erp(erp_category: str) -> Optional[str]:
    """Normalize an ERP Class_01 description to a known category.

    Used during index building where the category is already known from ERP.
    Returns the canonical category name or None if not recognized.
    """
    if not erp_category or not erp_category.strip():
        return None

    cleaned = erp_category.strip().upper()
    for known in KNOWN_CATEGORIES:
        if cleaned == known.upper():
            return known
    return None


def is_generic_rc(category: str) -> bool:
    """Check if a category is eligible for generic parametric matching.

    Returns True for WEERSTANDEN, CONDENSATOREN, and ELCO'S en TANTALEN.
    These categories support MPN-free parameterized search.
    """
    return category in GENERIC_RC_CATEGORIES
