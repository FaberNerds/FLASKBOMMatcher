"""
Category detection service for BOM Matcher.
Rule-based detection of ERP component categories from customer BOM descriptions and refdes.
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

# --- Detection rules ---
#
# Measured on 690 lines of 7 customer BOMs (refdes letter as reference): checking units first
# (as before) got 91% right: coils with "0.22Ohm DCR" became resistors, "170MHz" was read as a
# henry, "12.5pF" made a crystal a capacitor. Keywords first, then the refdes letter, then the
# units got 100%.

_STOP = object()  # a keyword that says "no ERP category to search in" (e.g. NTC): no fallback


def _words(*alternatives: str) -> re.Pattern:
    """Whole words only: not inside another word or part number (e.g. RES in PRESSURE)."""
    return re.compile(r'(?<![A-Z0-9])(?:' + '|'.join(alternatives) + r')(?![A-Z0-9])')


# 1. Keywords, first hit wins. The specific part types come before resistor and capacitor,
#    because their descriptions often carry an Ohm, pF or Hz value too.
_KEYWORD_RULES = [
    (_words(r'FERRITES?', r'FERRIET', r'BEADS?', r'FER\d{4}', r'COMMON MODE', r'LINE FILTERS?', r'EMI FILTERS?'),
     "SPOELEN en SUPPRESSORS"),
    (_words(r'INDUCTORS?', r'INDUCTANCE', r'COILS?', r'CHOKES?', r'SPOEL(?:EN)?', r'IND'), "SPOELEN en SUPPRESSORS"),
    (_words(r'CRYSTALS?', r'XTAL', r'KRISTAL(?:LEN)?', r'OSCILLATORS?', r'RESONATORS?'), "KRISTALLEN en OSCILLATOREN"),
    (_words(r'LEDS?', r'OPTO', r'OPTOCOUPLERS?', r'PHOTOCOUPLERS?', r'PHOTODIODES?', r'PHOTOTRANSISTORS?'), "LED / OPTO'S"),
    (_words(r'DIODES?', r'Z?DIODE', r'ZENER', r'TVS', r'ESD', r'SCHOTTKY', r'RECTIFIERS?', r'SUPPRESSORS?',
            r'TRIAC', r'DIAC', r'THYRISTORS?'), "DIODEN EN DIAC'S"),
    (_words(r'TRANSISTORS?', r'[NP]?MOSFETS?', r'JFET', r'IGBT', r'BJT', r'FET', r'NPN', r'PNP', r'TRANS'),
     "TRANSISTOREN en FETS"),
    (_words(r'FUSES?', r'POLYFUSE', r'ZEKERING(?:EN)?', r'PTC'), "ZEKERINGEN en HOUDERS"),
    (_words(r'RELAYS?', r'RELAIS'), "RELAIS en VOETEN"),
    (_words(r'CONNECTORS?', r'CONN', r'HEADERS?', r'SOCKETS?', r'RECEPTACLES?', r'PLUGS?', r'JACK', r'USB',
            r'RJ45', r'D-SUB'), "CONNECTOREN/PLUGGEN"),
    (_words(r'REGULATORS?', r'LDO', r'BUCK', r'BOOST', r'DC-?DC', r'SPANNINGSREGELAAR'), "SPANNINGSREGELAARS"),
    (_words(r'IC', r'MCU', r'MICROCONTROLLER', r'FPGA', r'CPU', r'PROCESSOR', r'OP-?AMPS?', r'OP AMP',
            r'COMPARATORS?', r'EEPROM', r'TRANSCEIVER', r'TRANCEIVER'), "INTEGRATED CIRCUITS"),
    (_words(r'SWITCH(?:ES)?', r'BUTTONS?', r'SCHAKELAAR', r'DRUKKNOP'), "SCHAKEL. en DRUKKN."),
    (_words(r'SCREWS?', r'NUTS?', r'BOLTS?', r'WASHERS?', r'STANDOFFS?', r'SPACERS?', r'BOUT', r'MOER'),
     "BEVESTIGINGSMATERIAAL"),
    # Not a generic resistor: never searched on parameters among the plain resistors
    (_words(r'NTC', r'THERMISTORS?', r'VARISTORS?', r'MOV', r'POTENTIOMETERS?', r'TRIMMERS?'), _STOP),
    (_words(r'ELCO(?:\'S)?', r'ELECTROLYTIC', r'LYTIC', r'TANTALUM', r'TANTAAL', r'TANT'), "ELCO'S en TANTALEN"),
    (_words(r'RES', r'RESISTORS?', r'WEERST(?:AND(?:EN)?)?', r'THICK FILM', r'THIN FILM', r'METAL FILM'),
     "WEERSTANDEN"),
    (_words(r'CAP', r'CAPACITORS?', r'CONDENSATOR(?:EN)?', r'COND', r'MLCC', r'CERAMIC', r'CER',
            r'C0G', r'COG', r'NP0', r'NPO', r'X5R', r'X6S', r'X7R', r'X7S', r'X8R', r'Y5V', r'Z5U'), "CONDENSATOREN"),
]
_PAT_CER_OR_SMD_PREFIX = re.compile(r'^(?:CER|SMD)\d')  # Exact style "CER0805 100N", "SMD0603 10N"

# 2. Refdes letter of the first designator
_REFDES_RULES = {
    'R': "WEERSTANDEN",
    'C': "CONDENSATOREN",
    'L': "SPOELEN en SUPPRESSORS", 'FB': "SPOELEN en SUPPRESSORS", 'FL': "SPOELEN en SUPPRESSORS",
    'D': "DIODEN EN DIAC'S", 'Z': "DIODEN EN DIAC'S", 'ZD': "DIODEN EN DIAC'S", 'CR': "DIODEN EN DIAC'S",
    'LED': "LED / OPTO'S", 'DS': "LED / OPTO'S",
    'Q': "TRANSISTOREN en FETS",
    'Y': "KRISTALLEN en OSCILLATOREN", 'XTAL': "KRISTALLEN en OSCILLATOREN",
    'U': "INTEGRATED CIRCUITS", 'IC': "INTEGRATED CIRCUITS",
    'J': "CONNECTOREN/PLUGGEN", 'P': "CONNECTOREN/PLUGGEN", 'CN': "CONNECTOREN/PLUGGEN", 'CON': "CONNECTOREN/PLUGGEN",
    'F': "ZEKERINGEN en HOUDERS",
    'K': "RELAIS en VOETEN", 'RL': "RELAIS en VOETEN",
    'SW': "SCHAKEL. en DRUKKN.", 'S': "SCHAKEL. en DRUKKN.",
}
# A refdes of an active part beats a passive keyword: "LT3420 Photoflash Capacitor Charger" on U5
_ACTIVE_REFDES = {'U', 'IC', 'Q'}
_PASSIVE_CATEGORIES = {"WEERSTANDEN", "CONDENSATOREN", "ELCO'S en TANTALEN"}

# 3. Units, only when neither a keyword nor the refdes decided
_PAT_HENRY = re.compile(r'(?<![A-Z0-9])\d+(?:[.,]\d+)?\s*[NUΜM]H(?![A-Z])')    # 2.2uH, not 1MHz
_PAT_FARAD = re.compile(r'(?<![A-Z])\d+(?:[.,]\d+)?\s*[PNUΜ]F(?![A-Z])')
_PAT_OHM = re.compile(r'\d+(?:[.,]\d+)?\s*[KMR]?\s*(?:OHMS?|Ω)')
_PAT_E_NOTATION = re.compile(r'(?<![A-Z0-9])\d+[ERKM]\d+(?![A-Z0-9])')            # 4K7, 10R, 4E7
_PAT_RESISTANCE_KM = re.compile(r'(?<![A-Z0-9])\d+(?:[.,]\d+)?[KM](?:\s|$)')       # 10K, 1M
_PAT_RESISTANCE_CONTEXT = re.compile(r'%|OHM|Ω')
_PAT_HERTZ = re.compile(r'\d+(?:[.,]\d+)?\s*[KMG]?HZ(?![A-Z])')
_PAT_ELCO_TANT = re.compile(r'ELCO|TANT|LYTIC')


def refdes_prefix(refdes: str) -> str:
    """Letters of the first designator: 'R12, R13' -> 'R', 'FB3' -> 'FB'."""
    first = re.split(r'[,;\s]+', str(refdes or '').strip())[0]
    match = re.match(r'[A-Za-z]+', first)
    return match.group(0).upper() if match else ''


def refdes_number(refdes: str) -> Optional[int]:
    """Lowest designator number on a line ('C12, C3' -> 3), None when there is none."""
    numbers = [int(n) for n in re.findall(r'(?<![0-9])[A-Za-z]+(\d+)', str(refdes or ''))]
    return min(numbers) if numbers else None


def detect_category(description: str, refdes: str = '') -> Optional[str]:
    """Detect the ERP category of a BOM line from its description (and refdes, when given).

    In priority order:
      1. Keywords as whole words; specific part types (coil, crystal, diode, transistor, IC...)
         before resistor and capacitor, whose units also appear in other parts' descriptions
      2. The refdes letter (R, C, L, D, Q, Y, U...)
      3. Units: henry, farad, ohm / 4K7, hertz

    Returns the ERP category name or None if undetected (or not a category to search in).
    """
    desc = (description or '').strip()
    prefix = refdes_prefix(refdes)
    if not desc and not prefix:
        return None
    text = desc.upper()

    for pattern, cat in _KEYWORD_RULES:
        if pattern.search(text):
            if cat is _STOP:
                logger.debug("Category detected (keyword, no category): %s", desc)
                return None
            if cat in _PASSIVE_CATEGORIES and prefix in _ACTIVE_REFDES:
                cat = _REFDES_RULES[prefix]
            logger.debug("Category detected (keyword): %s -> %s", desc, cat)
            return cat
    if _PAT_CER_OR_SMD_PREFIX.search(text):
        return "CONDENSATOREN"

    if prefix in _REFDES_RULES:
        cat = _REFDES_RULES[prefix]
        # The refdes says capacitor and the description says electrolytic / tantalum
        if cat == "CONDENSATOREN" and _PAT_ELCO_TANT.search(text):
            cat = "ELCO'S en TANTALEN"
        logger.debug("Category detected (refdes %s): %s -> %s", prefix, desc, cat)
        return cat

    if _PAT_HENRY.search(text):
        return "SPOELEN en SUPPRESSORS"
    if _PAT_FARAD.search(text):
        return "ELCO'S en TANTALEN" if _PAT_ELCO_TANT.search(text) else "CONDENSATOREN"
    if _PAT_OHM.search(text):
        return "WEERSTANDEN"
    if (_PAT_E_NOTATION.search(text) or _PAT_RESISTANCE_KM.search(text)) and _PAT_RESISTANCE_CONTEXT.search(text):
        return "WEERSTANDEN"
    if _PAT_HERTZ.search(text):
        return "KRISTALLEN en OSCILLATOREN"

    logger.debug("No category detected for: %s", desc)
    return None


# Groups on the match page: resistors, capacitors, coils and beads, the rest
_GROUP_OF_CATEGORY = {
    "WEERSTANDEN": 'resistor',
    "CONDENSATOREN": 'capacitor',
    "ELCO'S en TANTALEN": 'capacitor',
    "SPOELEN en SUPPRESSORS": 'inductor',
}


def component_group(category: Optional[str]) -> str:
    """'resistor', 'capacitor', 'inductor' or 'other' for an ERP category."""
    return _GROUP_OF_CATEGORY.get(category or '', 'other')


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
