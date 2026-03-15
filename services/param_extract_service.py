"""
param_extract_service.py

Extracts structured parameters from customer BOM descriptions using regex.
Given a description and a detected category, returns a dict of parameters
(value, package, tolerance, voltage, etc.) used to search the SQLite parameter index.
"""

import re
import logging
from typing import Dict, List

from services.category_index_service import (
    normalize_resistance,
    normalize_capacitance,
    normalize_inductance,
    normalize_package,
)
from services.package_alias_service import resolve_package_alias


logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared regex helpers
# ---------------------------------------------------------------------------

_SMD_PACKAGES = r'(?:\b|(?<=SMD)|(?<=CER)|(?<=RES)|(?<=CAP))(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b'
_TOLERANCE_RE = re.compile(r'[±]?\s*(\d+(?:[.,]\d+)?)\s*%', re.IGNORECASE)

_THROUGH_HOLE_PACKAGES = re.compile(
    r'\b(TSSOP-?\d+|QFN-?\d+|SOT-?23\d*|SOT-?223|SOT-?89|LQFP-?\d+|'
    r'DIP-?\d+|SOIC-?\d+|MSOP-?\d+|BGA-?\d+|SOP-?\d+|DPAK|D2PAK|'
    r'TO-?\d+|SOD-?123F?|DO-?\d+|SMA|SMB|SMC)\b', re.IGNORECASE)


def _find_tolerance(text: str) -> str | None:
    m = _TOLERANCE_RE.search(text)
    if m:
        return m.group(0).replace('±', '').strip()
    return None


def _find_smd_package(text: str) -> str | None:
    alias = resolve_package_alias(text)
    if alias:
        return normalize_package(alias)
    m = re.search(_SMD_PACKAGES, text)
    if m:
        return normalize_package(m.group(1))
    return None


def _find_ic_package(text: str) -> str | None:
    m = _THROUGH_HOLE_PACKAGES.search(text)
    if m:
        return m.group(0).upper()
    # Fall back to SMD package
    return _find_smd_package(text)


def _find_voltage(text: str) -> str | None:
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*V\b', text, re.IGNORECASE)
    if m:
        val = m.group(1).replace(',', '.')
        return f"{val}V"
    return None


# ---------------------------------------------------------------------------
# Per-category extractors
# ---------------------------------------------------------------------------

def _extract_weerstanden(desc: str) -> Dict[str, str]:
    """Extract resistor parameters."""
    params: Dict[str, str] = {}

    # --- Value ---
    # E-notation variants: 8E2, 4R7, 0R47, 1k54
    e_pat = re.search(
        r'\b(\d+)[ERKMekrm](\d+)\b', desc, re.IGNORECASE)
    # With unit suffix: 100K, 4.7K, 2.2M, 820R, 10R
    unit_pat = re.search(
        r'\b(\d+(?:[.,]\d+)?)\s*(K|M|R|OHM|KOHM|MOHM)\b', desc, re.IGNORECASE)
    # With 'ohm' spelled out: 10 ohm, 4.7kohm
    ohm_pat = re.search(
        r'\b(\d+(?:[.,]\d+)?)\s*[KkMm]?\s*[Oo][Hh][Mm]\b', desc)

    if e_pat:
        raw = e_pat.group(0)
        params['value'] = raw
    elif unit_pat:
        raw = unit_pat.group(0).strip()
        params['value'] = raw
    elif ohm_pat:
        raw = ohm_pat.group(0).strip()
        params['value'] = raw

    # Fallback: plain number as ohms (e.g. "150" in "Resistor 150 1% 50mW")
    _SMD_CODES = {'0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512'}
    if not params.get('value'):
        plain = re.search(
            r'\b(\d+(?:[.,]\d+)?)\b(?=\s+(?:\d|±|%|mW|W\b|V\b))',
            desc, re.IGNORECASE)
        if plain and plain.group(1) not in _SMD_CODES:
            params['value'] = plain.group(1) + 'R'

    # --- Tolerance ---
    tol = _find_tolerance(desc)
    if tol:
        params['tolerance'] = tol

    # --- Power rating ---
    # Milliwatt form: 50mW, 100mW
    mw = re.search(r'\b(\d+(?:[.,]\d+)?)\s*mW\b', desc, re.IGNORECASE)
    if mw:
        mw_val = float(mw.group(1).replace(',', '.'))
        params['power'] = f"{mw_val / 1000.0}W"
    # Fraction form: 1/4W, 1/8W
    elif (frac := re.search(r'\b(\d+)/(\d+)\s*W\b', desc, re.IGNORECASE)):
        val = round(int(frac.group(1)) / int(frac.group(2)), 4)
        params['power'] = f"{val}W"
    else:
        pw = re.search(r'\b(\d+(?:[.,]\d+)?)\s*W\b', desc, re.IGNORECASE)
        if pw:
            params['power'] = pw.group(0).replace(',', '.').upper().strip()

    # --- Package ---
    pkg = _find_smd_package(desc)
    if pkg:
        params['package'] = pkg

    return params


def _extract_condensatoren(desc: str) -> Dict[str, str]:
    """Extract capacitor parameters."""
    params: Dict[str, str] = {}

    # Capacitance: 100nF, 10uF, 4.7pF, 1µF, 4,7nF, 500fF
    cap = re.search(
        r'\b(\d+(?:[.,]\d+)?)\s*([fpnuµm]?F)\b', desc, re.IGNORECASE)
    if cap:
        val = cap.group(1).replace(',', '.')
        unit = cap.group(2).replace('µ', 'u')
        # Restore canonical casing: FF→fF, NF→nF, PF→pF, UF→uF, MF→mF
        if len(unit) == 2 and unit[1] == 'F':
            unit = unit[0].lower() + 'F'
        params['capacitance'] = f"{val}{unit}"

    # Voltage
    v = _find_voltage(desc)
    if v:
        params['voltage'] = v

    # Dielectric
    diel = re.search(r'\b(X[57][RST]|C0G|NP0|Y5V)\b', desc, re.IGNORECASE)
    if diel:
        params['dielectric'] = diel.group(1).upper()

    # Tolerance
    tol = _find_tolerance(desc)
    if tol:
        params['tolerance'] = tol

    # Package
    pkg = _find_smd_package(desc)
    if pkg:
        params['package'] = pkg

    return params


def _extract_integrated_circuits(desc: str) -> Dict[str, str]:
    """Extract IC parameters."""
    params: Dict[str, str] = {}

    # Package (detect first so we can exclude it from MPN search)
    pkg = _find_ic_package(desc)
    if pkg:
        params['package'] = pkg

    # Manufacturer keywords
    mfr_keywords = [
        'TI', 'ST', 'NXP', 'MICROCHIP', 'MAXIM', 'ANALOG',
        'INFINEON', 'ONSEMI', 'TEXAS INSTRUMENTS',
    ]
    for kw in mfr_keywords:
        if re.search(r'\b' + re.escape(kw) + r'\b', desc, re.IGNORECASE):
            params['manufacturer'] = kw.upper()
            break

    # MPN: longest alphanumeric token that isn't the package or manufacturer
    tokens = re.findall(r'[A-Za-z0-9][\w\-\.]*[A-Za-z0-9]', desc)
    exclude = {'IC', 'SMD', 'THT', 'TH'}
    if 'package' in params:
        exclude.add(params['package'].upper())
    if 'manufacturer' in params:
        exclude.add(params['manufacturer'].upper())
    candidates = [t for t in tokens if t.upper() not in exclude and len(t) >= 4]
    if candidates:
        params['mpn'] = max(candidates, key=len)

    return params


def _extract_connectoren(desc: str) -> Dict[str, str]:
    """Extract connector parameters."""
    params: Dict[str, str] = {}

    # Pin count: 2x5P, 10P, 20PIN, 20-PIN
    pin = re.search(r'\b(\d+(?:x\d+)?)\s*-?\s*(?:P(?:IN)?)\b', desc, re.IGNORECASE)
    if pin:
        params['pin_count'] = pin.group(1).upper() + 'P'

    # Pitch
    pitch = re.search(r'\b(\d+(?:\.\d+)?)\s*[Mm][Mm]\b', desc)
    if pitch:
        params['pitch'] = pitch.group(1) + 'mm'

    # Mounting
    mount = re.search(r'\b(SMD|SMT|THT|TH|THROUGH[\s.-]?HOLE)\b', desc, re.IGNORECASE)
    if mount:
        params['mounting'] = mount.group(1).upper().replace(' ', '').replace('.', '').replace('-', '')

    # Connector type
    types = ['HEADER', 'SOCKET', 'USB', 'RJ45', 'D-SUB', 'FPC', 'FFC', 'MOLEX', 'JST']
    for ct in types:
        if re.search(r'\b' + re.escape(ct) + r'\b', desc, re.IGNORECASE):
            params['connector_type'] = ct.upper()
            break

    return params


def _extract_dioden(desc: str) -> Dict[str, str]:
    """Extract diode parameters."""
    params: Dict[str, str] = {}

    # Diode type
    dtypes = ['SCHOTTKY', 'ZENER', 'TVS', 'SUPPRESSOR', 'RECTIFIER', 'SIGNAL']
    for dt in dtypes:
        if re.search(r'\b' + re.escape(dt) + r'\b', desc, re.IGNORECASE):
            params['diode_type'] = dt.upper()
            break

    # Package
    pkg = _find_ic_package(desc)
    if pkg:
        params['package'] = pkg

    # Voltage
    v = _find_voltage(desc)
    if v:
        params['voltage'] = v

    # MPN: longest token that is not a known keyword
    tokens = re.findall(r'[A-Za-z0-9][\w\-\.]*[A-Za-z0-9]', desc)
    exclude = {'DIODE', 'SMD', 'THT'} | {dt.upper() for dt in dtypes}
    if 'package' in params:
        exclude.add(params['package'].upper())
    candidates = [t for t in tokens if t.upper() not in exclude and len(t) >= 3]
    if candidates:
        params['mpn'] = max(candidates, key=len)

    return params


def _extract_transistoren(desc: str) -> Dict[str, str]:
    """Extract transistor / FET parameters."""
    params: Dict[str, str] = {}

    # Device type
    dev_types = ['MOSFET', 'FET', 'BJT', 'JFET', 'IGBT', 'NPN', 'PNP', 'N-CH', 'P-CH']
    for dt in dev_types:
        if re.search(r'\b' + re.escape(dt) + r'\b', desc, re.IGNORECASE):
            params['device_type'] = dt.upper()
            break

    # Package
    pkg = _find_ic_package(desc)
    if pkg:
        params['package'] = pkg

    # MPN
    tokens = re.findall(r'[A-Za-z0-9][\w\-\.]*[A-Za-z0-9]', desc)
    exclude = {'MOSFET', 'FET', 'BJT', 'JFET', 'IGBT', 'NPN', 'PNP', 'SMD', 'THT',
               'N-CH', 'P-CH', 'TRANSISTOR'}
    if 'package' in params:
        exclude.add(params['package'].upper())
    candidates = [t for t in tokens if t.upper() not in exclude and len(t) >= 3]
    if candidates:
        params['mpn'] = max(candidates, key=len)

    return params


def _extract_spoelen(desc: str) -> Dict[str, str]:
    """Extract inductor / ferrite bead parameters."""
    params: Dict[str, str] = {}

    # Inductance: 27uH, 100nH, 1mH, 4.7µH
    ind = re.search(r'\b(\d+(?:[.,]\d+)?)\s*([nuµm]H)\b', desc, re.IGNORECASE)
    if ind:
        val = ind.group(1).replace(',', '.')
        unit = ind.group(2).replace('µ', 'u')
        params['inductance'] = f"{val}{unit}"

    # Impedance for ferrite beads: 600R, 120OHM
    imp = re.search(r'\b(\d+(?:[.,]\d+)?)\s*(R|OHM)\b', desc, re.IGNORECASE)
    if imp and 'inductance' not in params:
        params['impedance'] = imp.group(1).replace(',', '.') + 'R'

    # Tolerance
    tol = _find_tolerance(desc)
    if tol:
        params['tolerance'] = tol

    # Package
    pkg = _find_smd_package(desc)
    if pkg:
        params['package'] = pkg

    return params


def _extract_elcos(desc: str) -> Dict[str, str]:
    """Extract electrolytic / tantalum capacitor parameters."""
    params: Dict[str, str] = {}

    # Capacitance
    cap = re.search(r'\b(\d+(?:[.,]\d+)?)\s*([nuµm]?F)\b', desc, re.IGNORECASE)
    if cap:
        val = cap.group(1).replace(',', '.')
        unit = cap.group(2).replace('µ', 'u')
        if len(unit) == 2 and unit[1] == 'F':
            unit = unit[0].lower() + 'F'
        params['capacitance'] = f"{val}{unit}"

    # Voltage
    v = _find_voltage(desc)
    if v:
        params['voltage'] = v

    # Case size: CASE-A .. CASE-E, SIZE-A .. SIZE-E, or dims like 6.3x5.8
    case = re.search(r'\b(?:CASE|SIZE)[- ]?([A-E])\b', desc, re.IGNORECASE)
    if case:
        params['case_size'] = f"CASE-{case.group(1).upper()}"
    else:
        dims = re.search(r'\b(\d+(?:\.\d+)?x\d+(?:\.\d+)?)\b', desc, re.IGNORECASE)
        if dims:
            params['case_size'] = dims.group(1)

    # Cap type
    cap_types = {'ELCO': 'ELCO', 'ELECTROLYTIC': 'ELECTROLYTIC',
                 'TANT': 'TANTALUM', 'TANTALUM': 'TANTALUM'}
    for kw, canonical in cap_types.items():
        if re.search(r'\b' + re.escape(kw) + r'\b', desc, re.IGNORECASE):
            params['cap_type'] = canonical
            break

    return params


# ---------------------------------------------------------------------------
# Category → extractor dispatch
# ---------------------------------------------------------------------------

_CATEGORY_MAP = {
    'WEERSTANDEN': _extract_weerstanden,
    'CONDENSATOREN': _extract_condensatoren,
    'INTEGRATED CIRCUITS': _extract_integrated_circuits,
    'CONNECTOREN': _extract_connectoren,
    'PLUGGEN': _extract_connectoren,
    'CONNECTOREN/PLUGGEN': _extract_connectoren,
    'DIODEN': _extract_dioden,
    'DIODEN EN DIAC\'S': _extract_dioden,
    'TRANSISTOREN': _extract_transistoren,
    'TRANSISTOREN EN FETS': _extract_transistoren,
    'SPOELEN': _extract_spoelen,
    'SPOELEN EN SUPPRESSORS': _extract_spoelen,
    'ELCO\'S': _extract_elcos,
    'ELCO\'S EN TANTALEN': _extract_elcos,
    'TANTALEN': _extract_elcos,
}


def extract_parameters(description: str, category: str) -> Dict[str, str]:
    """
    Extract structured parameters from a customer BOM description based on
    the detected component category.

    Returns a dict of parameter name → value, or empty dict if nothing found.
    """
    if not description or not category:
        return {}

    desc_upper = description.upper().strip()
    cat_upper = category.upper().strip()

    extractor = _CATEGORY_MAP.get(cat_upper)
    if extractor is None:
        logger.debug("No extractor for category '%s'", category)
        return {}

    params = extractor(desc_upper)
    logger.debug("Extracted params for '%s' [%s]: %s", description, category, params)
    return params


# ---------------------------------------------------------------------------
# Highlight helpers
# ---------------------------------------------------------------------------

_PARAM_COLORS = {
    'value': 'blue',
    'capacitance': 'blue',
    'inductance': 'blue',
    'impedance': 'blue',
    'voltage': 'green',
    'package': 'orange',
    'dielectric': 'purple',
    'tolerance': 'purple',
}


def get_match_highlights(
    query_params: Dict[str, str],
    erp_description: str,
    category: str,
) -> List[Dict]:
    """
    Identify which portions of the ERP description match the query parameters.
    Returns a list of highlight segment dicts with start, end, param, and color.
    """
    if not query_params or not erp_description:
        return []

    highlights: List[Dict] = []
    erp_upper = erp_description.upper()

    for param, value in query_params.items():
        if not value:
            continue
        val_upper = value.upper()
        idx = erp_upper.find(val_upper)

        # Comma/dot equivalence: try swapping , ↔ . if direct match fails
        if idx == -1 and ('.' in val_upper or ',' in val_upper):
            alt = val_upper.replace('.', ',') if '.' in val_upper else val_upper.replace(',', '.')
            idx = erp_upper.find(alt)
            if idx != -1:
                # Use the length of the alt string (same length)
                val_upper = alt

        if idx != -1:
            start = idx
            end = idx + len(val_upper)

            # Expand package highlights to include prefix like SMD, CER, RES
            if param == 'package' and start >= 3:
                prefix = erp_upper[start - 3:start]
                if prefix in ('SMD', 'CER', 'RES', 'CAP'):
                    start -= 3
                    # Also expand end to include trailing letter (e.g. "N" in SMD0603N)
                    while end < len(erp_upper) and erp_upper[end].isalpha():
                        end += 1

            highlights.append({
                'start': start,
                'end': end,
                'param': param,
                'color': _PARAM_COLORS.get(param, 'gray'),
            })

    # Sort by start position
    highlights.sort(key=lambda h: h['start'])
    return highlights


def get_mpn_highlights(
    customer_mpn: str,
    erp_description: str,
) -> List[Dict]:
    """
    Find where the customer MPN appears in the ERP description.
    Try exact match first, then progressively shorter prefixes (min 4 chars).
    """
    if not customer_mpn or not erp_description:
        return []

    mpn_upper = customer_mpn.upper().strip()
    erp_upper = erp_description.upper()

    # Exact substring match
    idx = erp_upper.find(mpn_upper)
    if idx != -1:
        return [{
            'start': idx,
            'end': idx + len(mpn_upper),
            'text': erp_description[idx:idx + len(mpn_upper)],
            'match_type': 'exact',
        }]

    # Progressive prefix match (min 4 chars)
    for length in range(len(mpn_upper) - 1, 3, -1):
        prefix = mpn_upper[:length]
        idx = erp_upper.find(prefix)
        if idx != -1:
            return [{
                'start': idx,
                'end': idx + length,
                'text': erp_description[idx:idx + length],
                'match_type': 'partial',
            }]

    return []
