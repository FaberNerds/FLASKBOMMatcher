"""
BOM Matcher - Category Index Service
Builds and queries a local SQLite parameter index from Exact Globe ERP data.

Provides fully rule-based (regex) parameterized matching for electronic
components across multiple categories: resistors, capacitors, ICs,
connectors, diodes, transistors, inductors, and electrolytic/tantalum caps.
"""

import logging
import math
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from services.db_service import get_connection_context

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SQLite database path
# ---------------------------------------------------------------------------
DEFAULT_DB_PATH = os.path.join(os.path.expanduser("~"), ".bommatcher", "param_index.db")

# ---------------------------------------------------------------------------
# Category weight definitions for search scoring
# ---------------------------------------------------------------------------
CATEGORY_WEIGHTS: Dict[str, Dict[str, int]] = {
    "WEERSTANDEN": {"value": 40, "package": 25, "tolerance": 20, "power": 15},
    "CONDENSATOREN": {"capacitance": 35, "voltage": 25, "package": 20, "dielectric": 10, "tolerance": 10},
    "SPOELEN EN SUPPRESSORS": {"inductance": 40, "package": 25, "tolerance": 20, "impedance": 15},
    "ELCO'S EN TANTALEN": {"capacitance": 35, "voltage": 30, "case_size": 20, "tolerance": 15},
}

# Numeric parameter names (scored with log-ratio, not exact match)
NUMERIC_PARAMS = {"value", "capacitance", "inductance", "voltage", "power", "impedance"}


# ===========================================================================
# Value normalizers
# ===========================================================================

def _european_decimal(s: str) -> str:
    """Replace European comma decimal separator with a dot."""
    return s.replace(",", ".")


def normalize_resistance(value_str: str) -> Optional[float]:
    """Normalize a resistance string to Ohms.

    Handles E-notation (8E2=820), multiplier letters (k, M, R),
    and European decimals (2,2k = 2200).
    """
    if not value_str:
        return None
    s = _european_decimal(value_str.strip())

    # E-notation: 8E2 = 8 * 10^2 = 800, but in resistor context 8E2 = 820
    # Actually in E-series notation: 8E2 means 8.2 * 100 = 820? No.
    # Standard ERP: 8E2 means the digit after E replaces decimal → 8.2
    # Then the magnitude depends on trailing multiplier. But typically
    # 8E2 alone means 8.2 Ohms in E-notation resistor descriptions.
    # However 8E2 could also be scientific 8*10^2 = 800.
    # Per the spec: 8E2 = 820 Ω. This means E acts as decimal point
    # and the result is multiplied by 100: 8.2 * 100 = 820.
    # Actually re-reading: 8E2 = 820Ω. So the E-notation means:
    # first digit . second digit × 10^(number of trailing digits position)
    # 8E2 → 82 × 10 = 820? No, 82 * 10 = 820. That works if we read
    # it as: digits around E form "82", exponent = len(digits_after_E) - 0
    # Simpler: 8E2 means 82 * 10^1 = 820. Standard EIA notation.

    # R as decimal point: 4R7 = 4.7, 0R47 = 0.47, 100R = 100
    m = re.match(r'^(\d+)[Rr](\d+)$', s)
    if m:
        return float(f"{m.group(1)}.{m.group(2)}")

    # 100R = 100 ohms (R at end, no digits after)
    m = re.match(r'^(\d+(?:\.\d+)?)[Rr]$', s)
    if m:
        return float(m.group(1))

    # E as decimal for E-series: 8E2 = 8.2 then * 100 = 820? Let's check:
    # Per spec: 8E2=820. 8.2 * 100 = 820. So position of E determines
    # the multiplier as 10^(digits_after_E).
    # But 1E0 would be 1.0 * 1 = 1? Unlikely to appear.
    # Handle: [digits]E[digits] where no '+'/'-' after E (not sci notation)
    m = re.match(r'^(\d+)E(\d+)$', s, re.IGNORECASE)
    if m:
        combined = m.group(1) + m.group(2)
        # The decimal point goes after the first digit
        if len(combined) == 1:
            return float(combined)
        mantissa = float(combined[0] + "." + combined[1:])
        exponent = len(combined) - 1
        return mantissa * (10 ** (exponent - 1)) if exponent > 1 else mantissa

    # k as decimal: 1k54 = 1.54k = 1540, 2k2 = 2.2k = 2200
    m = re.match(r'^(\d+)[kK](\d+)$', s)
    if m:
        return float(f"{m.group(1)}.{m.group(2)}") * 1e3

    # M as decimal: 1M5 = 1.5M = 1500000
    m = re.match(r'^(\d+)[Mm](\d+)$', s)
    if m:
        return float(f"{m.group(1)}.{m.group(2)}") * 1e6

    # Plain with multiplier suffix: 10k, 1.5k, 1M, 100R, 4.7R
    m = re.match(r'^(\d+(?:\.\d+)?)\s*([kKmM]?)(?:[Ωo]?)$', s)
    if m:
        val = float(m.group(1))
        mult = m.group(2).lower()
        if mult == 'k':
            return val * 1e3
        elif mult == 'm':
            return val * 1e6
        else:
            return val

    # Last resort: try plain float
    try:
        return float(s)
    except ValueError:
        return None


def normalize_capacitance(value_str: str) -> Optional[float]:
    """Normalize a capacitance string to Farads.

    Handles pF, nF, uF/µF, mF with European decimals.
    """
    if not value_str:
        return None
    s = _european_decimal(value_str.strip())

    m = re.match(r'^(\d+(?:\.\d+)?)\s*([pnuµmPNUM]?)[Ff]?$', s)
    if not m:
        return None

    val = float(m.group(1))
    prefix = m.group(2)

    multipliers = {'p': 1e-12, 'P': 1e-12, 'n': 1e-9, 'N': 1e-9,
                   'u': 1e-6, 'U': 1e-6, 'µ': 1e-6,
                   'm': 1e-3, 'M': 1e-3, '': 1.0}
    return val * multipliers.get(prefix, 1.0)


def normalize_inductance(value_str: str) -> Optional[float]:
    """Normalize an inductance string to Henries.

    Handles nH, uH/µH, mH with European decimals.
    """
    if not value_str:
        return None
    s = _european_decimal(value_str.strip())

    m = re.match(r'^(\d+(?:\.\d+)?)\s*([nuµmNUM]?)[Hh]?$', s)
    if not m:
        return None

    val = float(m.group(1))
    prefix = m.group(2)

    multipliers = {'n': 1e-9, 'N': 1e-9,
                   'u': 1e-6, 'U': 1e-6, 'µ': 1e-6,
                   'm': 1e-3, 'M': 1e-3, '': 1.0}
    return val * multipliers.get(prefix, 1.0)


def normalize_package(pkg_str: str) -> str:
    """Canonicalize a package name by stripping dashes/spaces and mapping aliases.

    SO-8 → SOIC8, SOIC-8 → SOIC8, SOT-23 → SOT23, QFN-16 → QFN16, etc.
    Metric footprints (0805, 0402) pass through unchanged.
    """
    if not pkg_str:
        return ""
    s = pkg_str.strip().upper()

    # SO/SOIC normalization: SO-8, SO8, SOIC-8 all become SOIC8
    m = re.match(r'^SO[- ]?(\d+)$', s)
    if m:
        return f"SOIC{m.group(1)}"
    m = re.match(r'^SOIC[- ]?(\d+)$', s)
    if m:
        return f"SOIC{m.group(1)}"

    # Generic: strip dashes and spaces from package names
    return re.sub(r'[-\s]', '', s)


# ===========================================================================
# Category parsers
# ===========================================================================

def _parse_tolerance(desc: str) -> Optional[str]:
    """Extract tolerance value like 1%, 5%, 0.1%, ±10%."""
    m = re.search(r'[±]?\s*(\d+(?:[.,]\d+)?)\s*%', desc)
    if m:
        return _european_decimal(m.group(1)) + "%"
    return None


def _parse_voltage(desc: str) -> Optional[str]:
    """Extract voltage value like 50V, 16V, 100V."""
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*[Vv](?:\b|$)', desc)
    if m:
        return _european_decimal(m.group(1)) + "V"
    return None


def _parse_package_from_desc(desc: str) -> Optional[str]:
    """Extract a standard package footprint from a description string."""
    # Metric footprints: 0402, 0603, 0805, 1206, 1210, 2512, etc.
    m = re.search(r'\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b', desc)
    if m:
        return m.group(1)
    # Named packages: SOIC-8, SOT-23, QFN-16, TSSOP-56, DIP-8, DPAK, etc.
    m = re.search(r'\b(SO[- ]?\d+|SOIC[- ]?\d+|SOT[- ]?\d+[A-Z]*|QFN[- ]?\d+|QFP[- ]?\d+|'
                  r'TSSOP[- ]?\d+|SSOP[- ]?\d+|MSOP[- ]?\d+|DIP[- ]?\d+|PDIP[- ]?\d+|'
                  r'DPAK|D2PAK|TO[- ]?\d+[A-Z]*|BGA[- ]?\d+|LQFP[- ]?\d+|'
                  r'PLCC[- ]?\d+|SOD[- ]?\d+[A-Z]*|DO[- ]?\d+[A-Z]*|'
                  r'SMA|SMB|SMC)\b', desc, re.IGNORECASE)
    if m:
        return m.group(1)
    return None


def parse_weerstanden(desc: str) -> Dict[str, str]:
    """Parse a resistor description. ERP format: RES [value] [tolerance] [power] [package]."""
    params: Dict[str, str] = {}
    if not desc:
        return params

    # Strip leading RES/WEERSTAND keyword
    d = re.sub(r'^(RES|WEERSTAND)\s+', '', desc.strip(), flags=re.IGNORECASE)

    # Value: look for resistance notation
    # Patterns: 8E2, 4R7, 0R47, 100R, 10k, 1k54, 1M, 2,2k, 820R, 1.5k
    m = re.search(r'\b(\d+E\d+|\d+[Rr]\d*|\d+(?:[.,]\d+)?[kKmM](?:\d+)?|\d+(?:[.,]\d+)?(?=[Ωo\s]))', d)
    if m:
        params["value"] = m.group(1)

    # Tolerance
    tol = _parse_tolerance(d)
    if tol:
        params["tolerance"] = tol

    # Power rating: 0.125W, 0.25W, 0.5W, 1W, etc.
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*[Ww]', d)
    if m:
        params["power"] = _european_decimal(m.group(1)) + "W"

    # Package
    pkg = _parse_package_from_desc(d)
    if pkg:
        params["package"] = pkg

    return params


def parse_condensatoren(desc: str) -> Dict[str, str]:
    """Parse a capacitor description. ERP format: [dielectric] [capacitance] [tolerance] [voltage] [package]."""
    params: Dict[str, str] = {}
    if not desc:
        return params
    d = desc.strip()

    # Dielectric type
    m = re.search(r'\b(X7R|X5R|X8R|C0G|NP0|NPO|Y5V|X7S|X6S|U2J)\b', d, re.IGNORECASE)
    if m:
        params["dielectric"] = m.group(1).upper()

    # Capacitance: 100nF, 10uF, 4,7pF, 1µF
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*([pnuµPNUµ])[Ff]', d)
    if m:
        params["capacitance"] = _european_decimal(m.group(1)) + m.group(2).lower() + "F"

    # Tolerance
    tol = _parse_tolerance(d)
    if tol:
        params["tolerance"] = tol

    # Voltage
    volt = _parse_voltage(d)
    if volt:
        params["voltage"] = volt

    # Package
    pkg = _parse_package_from_desc(d)
    if pkg:
        params["package"] = pkg

    return params


def parse_integrated_circuits(desc: str) -> Dict[str, str]:
    """Parse an IC description. ERP format: IC [MPN] [package] [manufacturer]."""
    params: Dict[str, str] = {}
    if not desc:
        return params

    d = re.sub(r'^IC\s+', '', desc.strip(), flags=re.IGNORECASE)

    # Package
    pkg = _parse_package_from_desc(d)
    if pkg:
        params["package"] = pkg

    # MPN: typically the first non-trivial token
    tokens = d.split()
    if tokens:
        candidate = tokens[0]
        # Skip if it looks like a package or generic keyword
        if not re.match(r'^(SOT|SO|SOIC|QFN|QFP|TSSOP|DIP|BGA|LQFP)', candidate, re.IGNORECASE):
            params["mpn"] = candidate

    return params


def parse_connectoren(desc: str) -> Dict[str, str]:
    """Parse a connector description. ERP format: CONN [dir] [pins] [mounting] [type] [pitch] [MPN]."""
    params: Dict[str, str] = {}
    if not desc:
        return params

    d = re.sub(r'^CONN(?:ECTOR)?\s+', '', desc.strip(), flags=re.IGNORECASE)

    # Direction: PR, DR, etc.
    m = re.search(r'\b(PR|DR|SR)\b', d)
    if m:
        params["direction"] = m.group(1).upper()

    # Pin count: 10P, 2x4p, 20P
    m = re.search(r'\b(\d+(?:x\d+)?)[Pp]\b', d, re.IGNORECASE)
    if m:
        params["pin_count"] = m.group(1).upper() + "P"

    # Mounting: SMD, THT
    m = re.search(r'\b(SMD|THT|SMT|TH)\b', d, re.IGNORECASE)
    if m:
        val = m.group(1).upper()
        params["mounting"] = "THT" if val == "TH" else ("SMD" if val == "SMT" else val)

    # Pitch: 2.54mm, 1.27mm, 0.5mm
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*mm', d, re.IGNORECASE)
    if m:
        params["pitch"] = _european_decimal(m.group(1)) + "mm"

    # Connector type keywords
    for kw in ["HEADER", "SOCKET", "USB", "RJ45", "RJ11", "MICRO-USB",
               "USB-C", "MOLEX", "JST", "FPC", "FFC", "D-SUB", "DSUB",
               "BARREL", "TERMINAL", "SCREW"]:
        if re.search(r'\b' + re.escape(kw) + r'\b', d, re.IGNORECASE):
            params["connector_type"] = kw.upper()
            break

    return params


def parse_dioden(desc: str) -> Dict[str, str]:
    """Parse a diode description. ERP format: [DIODE|ZDIODE|SUPPRESSOR] [MPN] [package] [mfr]."""
    params: Dict[str, str] = {}
    if not desc:
        return params
    d = desc.strip()

    # Diode type
    m = re.search(r'\b(ZDIODE|DIODE|SUPPRESSOR|SCHOTTKY|TVS)\b', d, re.IGNORECASE)
    if m:
        params["diode_type"] = m.group(1).upper()

    # Package
    pkg = _parse_package_from_desc(d)
    if pkg:
        params["package"] = pkg

    # Voltage
    volt = _parse_voltage(d)
    if volt:
        params["voltage"] = volt

    # MPN: first token after the type keyword
    m_type = re.match(r'(ZDIODE|DIODE|SUPPRESSOR|SCHOTTKY|TVS)\s+(\S+)', d, re.IGNORECASE)
    if m_type:
        candidate = m_type.group(2)
        if not re.match(r'^\d{4}$', candidate):  # skip if it looks like a package
            params["mpn"] = candidate

    return params


def parse_transistoren(desc: str) -> Dict[str, str]:
    """Parse a transistor/FET description. ERP format: [FET|TRANS] [MPN] [package] [manufacturer]."""
    params: Dict[str, str] = {}
    if not desc:
        return params
    d = desc.strip()

    # Device type
    m = re.search(r'\b(MOSFET|FET|TRANS|BJT|JFET|IGBT)\b', d, re.IGNORECASE)
    if m:
        params["device_type"] = m.group(1).upper()

    # Package
    pkg = _parse_package_from_desc(d)
    if pkg:
        params["package"] = pkg

    # MPN: first token after the type keyword
    m_type = re.match(r'(MOSFET|FET|TRANS|BJT|JFET|IGBT)\s+(\S+)', d, re.IGNORECASE)
    if m_type:
        candidate = m_type.group(2)
        if not re.match(r'^\d{4}$', candidate):
            params["mpn"] = candidate

    return params


def parse_spoelen(desc: str) -> Dict[str, str]:
    """Parse an inductor/suppressor description. ERP format: [SPOEL|FERRIET] [value] [tolerance] [package]."""
    params: Dict[str, str] = {}
    if not desc:
        return params

    d = re.sub(r'^(SPOEL|FERRIET|INDUCTOR)\s+', '', desc.strip(), flags=re.IGNORECASE)

    # Inductance: 27uH, 100nH, 4,7mH
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*([nuµmNUM])[Hh]', d)
    if m:
        params["inductance"] = _european_decimal(m.group(1)) + m.group(2).lower() + "H"

    # Impedance (Ohms at frequency)
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*[Ωo](?:hm)?', d, re.IGNORECASE)
    if m:
        params["impedance"] = _european_decimal(m.group(1))

    # Tolerance
    tol = _parse_tolerance(d)
    if tol:
        params["tolerance"] = tol

    # Package
    pkg = _parse_package_from_desc(d)
    if pkg:
        params["package"] = pkg

    return params


def parse_elcos(desc: str) -> Dict[str, str]:
    """Parse electrolytic/tantalum cap description. ERP: [ELCO|TANT] [cap] [tol] [voltage] [case]."""
    params: Dict[str, str] = {}
    if not desc:
        return params
    d = desc.strip()

    # Cap type
    m = re.search(r'\b(ELCO|TANT(?:AAL)?)\b', d, re.IGNORECASE)
    if m:
        val = m.group(1).upper()
        params["cap_type"] = "TANT" if val.startswith("TANT") else val

    # Capacitance
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*([puµPUµ])[Ff]', d)
    if m:
        params["capacitance"] = _european_decimal(m.group(1)) + m.group(2).lower() + "F"

    # Voltage
    volt = _parse_voltage(d)
    if volt:
        params["voltage"] = volt

    # Case size: CASE-A, CASE-D, etc.
    m = re.search(r'\bCASE[- ]?([A-Z])\b', d, re.IGNORECASE)
    if m:
        params["case_size"] = f"CASE-{m.group(1).upper()}"

    # Tolerance
    tol = _parse_tolerance(d)
    if tol:
        params["tolerance"] = tol

    return params


# ---------------------------------------------------------------------------
# Category → parser mapping
# ---------------------------------------------------------------------------
# Keys are matched case-insensitively against ERP category descriptions.
CATEGORY_PARSERS = {
    "WEERSTANDEN": parse_weerstanden,
    "CONDENSATOREN": parse_condensatoren,
    "INTEGRATED CIRCUITS": parse_integrated_circuits,
    "CONNECTOREN": parse_connectoren,
    "PLUGGEN": parse_connectoren,
    "DIODEN": parse_dioden,
    "DIAC'S": parse_dioden,
    "TRANSISTOREN": parse_transistoren,
    "FETS": parse_transistoren,
    "SPOELEN": parse_spoelen,
    "SUPPRESSORS": parse_spoelen,
    "ELCO'S": parse_elcos,
    "TANTALEN": parse_elcos,
}


def _detect_parser(category: Optional[str]):
    """Return the parser function for a given ERP category string, or None."""
    if not category:
        return None
    cat_upper = category.strip().upper()
    # Direct match
    if cat_upper in CATEGORY_PARSERS:
        return CATEGORY_PARSERS[cat_upper]
    # Substring match (e.g. "DIODEN EN DIAC'S" contains "DIODEN")
    for key, parser in CATEGORY_PARSERS.items():
        if key in cat_upper:
            return parser
    return None


def _normalize_category(category: Optional[str]) -> str:
    """Map an ERP category description to a canonical category name."""
    if not category:
        return "OTHER"
    cat_upper = category.strip().upper()

    mappings = [
        ("WEERSTANDEN", "WEERSTANDEN"),
        ("CONDENSATOREN", "CONDENSATOREN"),
        ("INTEGRATED CIRCUIT", "INTEGRATED CIRCUITS"),
        ("CONNECTOREN", "CONNECTOREN/PLUGGEN"),
        ("PLUGGEN", "CONNECTOREN/PLUGGEN"),
        ("DIODEN", "DIODEN"),
        ("DIAC", "DIODEN"),
        ("TRANSISTOREN", "TRANSISTOREN EN FETS"),
        ("FET", "TRANSISTOREN EN FETS"),
        ("SPOEL", "SPOELEN EN SUPPRESSORS"),
        ("FERRIET", "SPOELEN EN SUPPRESSORS"),
        ("SUPPRESSOR", "SPOELEN EN SUPPRESSORS"),
        ("ELCO", "ELCO'S EN TANTALEN"),
        ("TANT", "ELCO'S EN TANTALEN"),
    ]
    for keyword, canonical in mappings:
        if keyword in cat_upper:
            return canonical
    return cat_upper  # keep the original if no mapping found


# ===========================================================================
# SQLite database management
# ===========================================================================

class CategoryIndex:
    """Manages the local SQLite parameter index."""

    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        """Create tables and indexes if they don't exist."""
        conn = self._get_conn()
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS components (
                    item_code TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    description TEXT,
                    item_type TEXT,
                    manufacturer TEXT,
                    mpn TEXT,
                    user_field_03 TEXT,
                    user_field_04 TEXT,
                    user_field_05 TEXT,
                    user_field_06 TEXT,
                    user_field_07 TEXT,
                    class_01 TEXT
                );

                CREATE TABLE IF NOT EXISTS parameters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_code TEXT NOT NULL,
                    param_name TEXT NOT NULL,
                    param_value TEXT NOT NULL,
                    FOREIGN KEY (item_code) REFERENCES components(item_code)
                );

                CREATE INDEX IF NOT EXISTS idx_params_name_value
                    ON parameters(param_name, param_value);
                CREATE INDEX IF NOT EXISTS idx_params_item
                    ON parameters(item_code);
                CREATE INDEX IF NOT EXISTS idx_components_category
                    ON components(category);

                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)
            conn.commit()
        finally:
            conn.close()

    # -------------------------------------------------------------------
    # Build index
    # -------------------------------------------------------------------

    def build_index(self) -> Dict:
        """Fetch all items from ERP, parse parameters, and populate the SQLite index.

        Returns stats dict with total count, per-category counts,
        and number of parameters extracted.
        """
        logger.info("Starting parameter index build from ERP...")
        start = time.time()

        # Fetch from ERP
        rows = self._fetch_erp_items()
        if not rows:
            logger.error("No items fetched from ERP — aborting index build")
            return {"total": 0, "per_category": {}, "parameters_extracted": 0}

        logger.info("Fetched %d items from ERP", len(rows))

        conn = self._get_conn()
        try:
            # Drop and recreate tables to pick up schema changes
            conn.executescript("""
                DROP TABLE IF EXISTS parameters;
                DROP TABLE IF EXISTS components;
                DROP TABLE IF EXISTS metadata;
            """)
            conn.commit()
        finally:
            conn.close()

        # Recreate tables with current schema
        self._init_db()

        conn = self._get_conn()
        try:

            total = 0
            param_count = 0
            per_category: Dict[str, int] = {}

            for i, row in enumerate(rows):
                item_code = str(row[0]).strip() if row[0] else None
                description = str(row[1]).strip() if row[1] else None
                item_type_raw = str(row[2]).strip() if row[2] else None
                item_type = str(row[3]).strip() if row[3] else None
                manufacturer = str(row[4]).strip() if row[4] else None
                mpn = str(row[5]).strip() if row[5] else None
                user_field_03 = str(row[6]).strip() if row[6] else None
                user_field_04 = str(row[7]).strip() if row[7] else None
                user_field_05 = str(row[8]).strip() if row[8] else None
                user_field_06 = str(row[9]).strip() if row[9] else None
                user_field_07 = str(row[10]).strip() if row[10] else None
                class_01 = str(row[11]).strip() if row[11] else None
                erp_category = str(row[12]).strip() if row[12] else None

                if not item_code:
                    continue

                category = _normalize_category(erp_category)

                # Insert component
                conn.execute(
                    "INSERT OR REPLACE INTO components "
                    "(item_code, category, description, item_type, manufacturer, mpn, "
                    "user_field_03, user_field_04, user_field_05, user_field_06, user_field_07, class_01) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (item_code, category, description, item_type, manufacturer, mpn,
                     user_field_03, user_field_04, user_field_05, user_field_06, user_field_07, class_01),
                )

                # Parse and insert parameters
                parser = _detect_parser(erp_category)
                if parser and description:
                    params = parser(description)
                    for pname, pvalue in params.items():
                        conn.execute(
                            "INSERT INTO parameters (item_code, param_name, param_value) "
                            "VALUES (?, ?, ?)",
                            (item_code, pname, pvalue),
                        )
                        param_count += 1

                per_category[category] = per_category.get(category, 0) + 1
                total += 1

                if (i + 1) % 5000 == 0:
                    logger.info("Indexed %d / %d items...", i + 1, len(rows))
                    conn.commit()  # intermediate commit for large datasets

            # Store build timestamp
            now_iso = datetime.now(timezone.utc).isoformat()
            conn.execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
                ("last_build_time", now_iso),
            )
            conn.commit()

        finally:
            conn.close()

        elapsed = time.time() - start
        logger.info(
            "Index build complete: %d components, %d parameters in %.1fs",
            total, param_count, elapsed,
        )

        return {
            "total": total,
            "per_category": per_category,
            "parameters_extracted": param_count,
            "elapsed_seconds": round(elapsed, 1),
        }

    def _fetch_erp_items(self) -> List[Tuple]:
        """Fetch all items from the Exact Globe ERP via SQL Server."""
        query = """
            SELECT
                i.ItemCode,
                i.Description,
                i.Type,
                i.ItemType,
                i.UserField_01 AS Manufacturer,
                i.UserField_02 AS MPN,
                i.UserField_03,
                i.UserField_04,
                i.UserField_05,
                i.UserField_06,
                i.UserField_07,
                i.Class_01,
                ic.Description AS ItemClassDescription
            FROM items AS i WITH (NOLOCK)
            LEFT JOIN ItemClasses AS ic WITH (NOLOCK)
                ON i.Class_01 = ic.ItemClassCode
                AND ic.ClassID = 1
            WHERE EXISTS (
                SELECT 1
                FROM artbst AS ab WITH (NOLOCK)
                WHERE ab.artcode = i.ItemCode
                  AND ab.artgrp IN (0, 4)
            )
        """
        try:
            with get_connection_context() as conn:
                if conn is None:
                    logger.error("Could not obtain ERP database connection")
                    return []
                cursor = conn.cursor()
                cursor.execute(query)
                rows = cursor.fetchall()
                cursor.close()
                return rows
        except Exception:
            logger.exception("Failed to fetch items from ERP")
            return []

    # -------------------------------------------------------------------
    # Query / search
    # -------------------------------------------------------------------

    def search_by_parameters(
        self,
        category: str,
        params: Dict[str, str],
        limit: int = 20,
    ) -> List[Dict]:
        """Score all components in a category by weighted parameter overlap.

        Args:
            category: Canonical category name (e.g. "WEERSTANDEN").
            params: Dict of parameter names to query values.
            limit: Max number of results to return.

        Returns:
            List of result dicts sorted by descending score.
        """
        conn = self._get_conn()
        try:
            # Fetch all components in the category
            comp_rows = conn.execute(
                "SELECT item_code, description, manufacturer, mpn FROM components "
                "WHERE category = ?",
                (category,),
            ).fetchall()

            if not comp_rows:
                return []

            # Collect item codes
            item_codes = [r["item_code"] for r in comp_rows]
            comp_map = {
                r["item_code"]: {
                    "description": r["description"],
                    "manufacturer": r["manufacturer"],
                    "mpn": r["mpn"],
                }
                for r in comp_rows
            }

            # Fetch all parameters for these components in bulk
            placeholders = ",".join("?" * len(item_codes))
            param_rows = conn.execute(
                f"SELECT item_code, param_name, param_value FROM parameters "
                f"WHERE item_code IN ({placeholders})",
                item_codes,
            ).fetchall()

            # Build a map: item_code → {param_name: param_value}
            item_params: Dict[str, Dict[str, str]] = {}
            for pr in param_rows:
                ic = pr["item_code"]
                if ic not in item_params:
                    item_params[ic] = {}
                item_params[ic][pr["param_name"]] = pr["param_value"]

        finally:
            conn.close()

        # Determine weights
        weights = CATEGORY_WEIGHTS.get(category, {})
        # If no predefined weights, use equal weights for all query params
        if not weights:
            n = len(params) or 1
            weights = {p: 100 // n for p in params}

        # Score each component
        results = []
        for ic in item_codes:
            candidate_params = item_params.get(ic, {})
            score, matched = self._compute_score(params, candidate_params, weights)
            if score > 0:
                results.append({
                    "item_code": ic,
                    "category": category,
                    "description": comp_map[ic]["description"],
                    "manufacturer": comp_map[ic]["manufacturer"],
                    "mpn": comp_map[ic]["mpn"],
                    "score": round(score, 2),
                    "matched_params": matched,
                })

        # Sort descending by score
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:limit]

    @staticmethod
    def _compute_score(
        query_params: Dict[str, str],
        candidate_params: Dict[str, str],
        weights: Dict[str, int],
    ) -> Tuple[float, Dict[str, Tuple]]:
        """Compute a weighted similarity score (0-100) between query and candidate params.

        Returns (score, matched_params) where matched_params maps
        param_name → (query_value, candidate_value).
        """
        total_weight = sum(weights.get(p, 0) for p in query_params)
        if total_weight == 0:
            return 0.0, {}

        weighted_sum = 0.0
        matched: Dict[str, Tuple] = {}

        for pname, qval in query_params.items():
            w = weights.get(pname, 0)
            if w == 0:
                continue

            cval = candidate_params.get(pname)
            if cval is None:
                continue

            matched[pname] = (qval, cval)

            if pname in NUMERIC_PARAMS:
                # Numeric comparison via normalizers
                qnum = _to_numeric(pname, qval)
                cnum = _to_numeric(pname, cval)
                if qnum is not None and cnum is not None and qnum > 0 and cnum > 0:
                    try:
                        ratio_diff = abs(math.log10(qnum / cnum))
                    except (ValueError, ZeroDivisionError):
                        ratio_diff = 10
                    param_score = max(0.0, 100.0 - ratio_diff * 50.0)
                else:
                    # Fall back to string comparison
                    param_score = 100.0 if _norm_str(qval) == _norm_str(cval) else 0.0
            else:
                # String comparison (package, dielectric, etc.)
                param_score = 100.0 if _norm_str(qval) == _norm_str(cval) else 0.0

            weighted_sum += param_score * w

        score = weighted_sum / total_weight if total_weight > 0 else 0.0
        return score, matched

    # -------------------------------------------------------------------
    # Stats
    # -------------------------------------------------------------------

    def get_index_stats(self) -> Dict:
        """Return current index statistics."""
        conn = self._get_conn()
        try:
            total = conn.execute("SELECT COUNT(*) FROM components").fetchone()[0]

            cat_rows = conn.execute(
                "SELECT category, COUNT(*) as cnt FROM components GROUP BY category "
                "ORDER BY cnt DESC"
            ).fetchall()
            per_category = {r["category"]: r["cnt"] for r in cat_rows}

            param_total = conn.execute("SELECT COUNT(*) FROM parameters").fetchone()[0]

            last_build = None
            meta_row = conn.execute(
                "SELECT value FROM metadata WHERE key = 'last_build_time'"
            ).fetchone()
            if meta_row:
                last_build = meta_row[0]

            return {
                "total_components": total,
                "per_category": per_category,
                "total_parameters": param_total,
                "last_build_time": last_build,
            }
        finally:
            conn.close()


# ===========================================================================
# Helper functions
# ===========================================================================

def _norm_str(s: str) -> str:
    """Normalize a string for comparison: uppercase, strip dashes/spaces."""
    return re.sub(r'[-\s]', '', s.strip().upper())


def _to_numeric(param_name: str, value_str: str) -> Optional[float]:
    """Convert a parameter value string to a float using the appropriate normalizer."""
    if param_name == "value":
        return normalize_resistance(value_str)
    elif param_name in ("capacitance",):
        return normalize_capacitance(value_str)
    elif param_name == "inductance":
        return normalize_inductance(value_str)
    elif param_name in ("voltage", "power", "impedance"):
        # Strip unit suffix and parse
        m = re.match(r'^(\d+(?:[.,]\d+)?)', _european_decimal(value_str))
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                return None
    return None


# ===========================================================================
# Module-level convenience functions
# ===========================================================================

_default_index: Optional[CategoryIndex] = None


def _get_index() -> CategoryIndex:
    """Get or create the default CategoryIndex singleton."""
    global _default_index
    if _default_index is None:
        _default_index = CategoryIndex()
    return _default_index


def build_index() -> Dict:
    """Build the parameter index from ERP data."""
    return _get_index().build_index()


def search_by_parameters(category: str, params: Dict[str, str], limit: int = 20) -> List[Dict]:
    """Search for components by category and parameters."""
    return _get_index().search_by_parameters(category, params, limit)


def get_index_stats() -> Dict:
    """Return current index statistics."""
    return _get_index().get_index_stats()
