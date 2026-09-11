"""
Regression tests for value parsing on BOTH sides of the matcher:

  * customer-BOM side:  services.param_extract_service.extract_parameters
  * ERP-index side:     services.category_index_service.parse_*

Every case below is a real notation seen in customer BOMs (Gemini PMC2,
CDI Devboard, SSA_ROE) or in ERP descriptions from the parameter index.
If a notation is added here it is guaranteed to extract identically on
both sides, because both call the shared find_capacitance / find_voltage.
"""

import pytest

from services.category_index_service import (
    find_capacitance,
    find_voltage,
    normalize_capacitance,
    normalize_inductance,
    normalize_micro,
    parse_condensatoren,
    parse_elcos,
)
from services.param_extract_service import extract_parameters


# ---------------------------------------------------------------------------
# find_capacitance (shared)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text, expected_farads", [
    # explicit unit
    ("C0G 330pF 5% 50V 0603", 330e-12),
    ("X7R 4,7nF 10% 50V 0603", 4.7e-9),
    ("X5R 10UF 20% 50V 0805", 10e-6),
    ("CAPACITOR, 1µF, 100V, 2220, X7R, 10%", 1e-6),          # micro sign
    ("CAPACITOR, 1μF, 100V", 1e-6),                     # Greek small mu
    ("CAPACITOR, 1ΜF, 100V", 1e-6),                     # Greek capital mu (after .upper())
    ("500fF 0201", 500e-15),
    ("COND 22MF 20% BZ054B223ZSB AVX", 22e-3),
    ("MKP13uF 5%900V C4AQOLW5130M36J KEMET", 13e-6),         # glued prefix
    ("COND NETW X7R 10nFx4 10% 0612", 10e-9),                 # network cap
    ("Cap 100uF; Tol 20%", 100e-6),
    # multiplier as decimal point
    ("6p8 16V Generic Capacitor CER0402N", 6.8e-12),
    ("2u2 16V Generic Capacitor CER0402N", 2.2e-6),
    ("9p1 16V Generic Capacitor CER0402N", 9.1e-12),
    ("4u7 50V Generic Capacitor CER0805N", 4.7e-6),
    ("ELCO 3U3 100V 20% 105C CASE-E SMD", 3.3e-6),
    ("NP0 0P47 +/- 0P25 50V 0603", 0.47e-12),
    ("C0G 3N3 10% 50V 0603", 3.3e-9),
    # bare multiplier
    ("68p 16V Generic Capacitor CER0603N", 68e-12),
    ("1u 16V Generic Capacitor CER0603N", 1e-6),
    ("220n 16V Generic Capacitor CER0603N", 220e-9),
    ("100n 100V Generic Capacitor CER0805N", 100e-9),
    ("1n 2kv Generic Capacitor CER1206N", 1e-9),
    ("C0G 33P 5% 50V 0805", 33e-12),
    ("C0G 0,5P +/-0,1P 0201", 0.5e-12),
    ("VERVAL ELCO 5.08 220u,35V,10%, low esr", 220e-6),
    # plain farads (supercaps)
    ("ELCO 1F +80/-20% 3,6V 5MM RAD", 1.0),
    ("ELCO 0,22F 20% 5V RAD", 0.22),
    ("SUPERCAP 150F -10%/+30% 3,8V", 150.0),
])
def test_find_capacitance(text, expected_farads):
    found = find_capacitance(text)
    assert found is not None, f"no capacitance found in {text!r}"
    assert normalize_capacitance(found) == pytest.approx(expected_farads, rel=1e-9)
    # uppercase input (what the BOM extractor feeds) must give the same answer
    assert normalize_capacitance(find_capacitance(normalize_micro(text).upper())) == \
        pytest.approx(expected_farads, rel=1e-9)


@pytest.mark.parametrize("text", [
    "RES 10K0 1% 0,1W 0603",
    "Generic Resistor RES0603N",
    "0603N",                    # a package code with a suffix is not 603 nF
    "SMD0402 X7R",
    "",
])
def test_find_capacitance_ignores_non_values(text):
    assert find_capacitance(text) is None


def test_find_capacitance_prefers_explicit_unit_over_shorthand():
    # tolerance shorthand "+/-0,25P" must not win over the real value
    assert normalize_capacitance(find_capacitance("C0G 3,3PF +/-0,25P 50V 0402")) == pytest.approx(3.3e-12)


# ---------------------------------------------------------------------------
# find_voltage (shared)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text, expected", [
    ("68p 16V Generic Capacitor CER0603N", "16V"),
    ("X5R 4,7UF 10% 6V3 0805", "6.3V"),
    ("10u 6V3 Generic Capacitor CER0402N", "6.3V"),
    ("X5R 22uF 20% 6,3V 0603", "6.3V"),
    ("X5R 10uF 20% 6.3V 0402", "6.3V"),
    ("1n 2kv Generic Capacitor CER1206N", "2000V"),
    ("KER 4N7 10% 1kV 7,5mm RAD", "1000V"),
    ("COND 1,5 kV", "1500V"),
    ("Aluminium Electrolytic Capacitors - SMD 50VDC 82uF 20%", "50V"),
    ("MKP 0,047 275VAC 15mm X2", "275V"),
    ("COND MKP-5MM 22n,160V,1%, MKP", "160V"),
    ("Schottky Diodes & Rectifiers 170 V, 3 A", "170V"),
])
def test_find_voltage(text, expected):
    assert find_voltage(text) == expected
    assert find_voltage(text.upper()) == expected


@pytest.mark.parametrize("text", [
    "Y5V 10uF 20% 1206",                        # dielectric code, not 5 V
    "VERVALLEN VPI IC ATMEGA162V-8MU MLF-44",   # MPN fragment
    "RES 294K 1% 0603 ERJ-3EKF2943V",           # MPN fragment
    "RES 10K0 1% 0,1W 0603",
])
def test_find_voltage_ignores_non_values(text):
    assert find_voltage(text) is None


# ---------------------------------------------------------------------------
# normalizers accept every mu variant
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", ["1uF", "1µF", "1μF", "1ΜF", "1UF"])
def test_normalize_capacitance_mu_variants(value):
    assert normalize_capacitance(value) == pytest.approx(1e-6)


@pytest.mark.parametrize("value", ["4.7uH", "4,7µH", "4.7μH", "4.7ΜH"])
def test_normalize_inductance_mu_variants(value):
    assert normalize_inductance(value) == pytest.approx(4.7e-6)


# ---------------------------------------------------------------------------
# BOM-side extractor end to end (what the matcher actually calls)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("desc, farads, voltage, package", [
    ("68p 16V Generic Capacitor CER0603N", 68e-12, "16V", "0603"),
    ("1u 16V Generic Capacitor CER0603N", 1e-6, "16V", "0603"),
    ("47u 10V Generic Capacitor CER0805N", 47e-6, "10V", "0805"),
    ("6p8 16V Generic Capacitor CER0402N", 6.8e-12, "16V", "0402"),
    ("2u2 16V Generic Capacitor CER0402N", 2.2e-6, "16V", "0402"),
    ("220n 16V Generic Capacitor CER0603N", 220e-9, "16V", "0603"),
    ("10u 6V3 Generic Capacitor CER0402N", 10e-6, "6.3V", "0402"),
    ("1n 2kv Generic Capacitor CER1206N", 1e-9, "2000V", "1206"),
    ("4u7 100V Generic Capacitor CER1210N", 4.7e-6, "100V", "1210"),
    ("CAPACITOR, 1µF, 100V, 2220, X7R, 10%", 1e-6, "100V", "2220"),
    ("MLCC, C0G, 100pF, 50V, 5%, 0603", 100e-12, "50V", "0603"),
    ("Generic Capacitor 0402 2.2nF", 2.2e-9, None, "0402"),
])
def test_extract_capacitor_params(desc, farads, voltage, package):
    params = extract_parameters(desc, "CONDENSATOREN")
    assert normalize_capacitance(params.get("capacitance")) == pytest.approx(farads, rel=1e-9)
    assert params.get("voltage") == voltage
    assert params.get("package") == package


@pytest.mark.parametrize("desc, farads, voltage", [
    ("68µF, 16V, 10%, TANT, CASE D", 68e-6, "16V"),
    ("Capacitor; Tantalum; Cap 100uF; Tol 20%; Solid SMT; Vol-Rtg 10V", 100e-6, "10V"),
    ("Aluminium Electrolytic Capacitors - SMD 50VDC 82uF 20% 6.3x7.7mm", 82e-6, "50V"),
])
def test_extract_elco_params(desc, farads, voltage):
    params = extract_parameters(desc, "ELCO'S EN TANTALEN")
    assert normalize_capacitance(params.get("capacitance")) == pytest.approx(farads, rel=1e-9)
    assert params.get("voltage") == voltage


@pytest.mark.parametrize("desc, expected_value", [
    ("10k Generic Resistor RES0603N", "10K"),
    ("8k2 Generic Resistor RES0603N", "8K2"),
    ("330R Generic Resistor RES0603N", "330R"),
    ("0R30 Generic Resistor RES1206N", "0R30"),
    ("4M7 Generic Resistor RES1206N", "4M7"),
    ("6.04k Generic Resistor RES0402N", "6.04K"),
    ("0R Generic Resistor RES0402N", "0R"),
])
def test_extract_resistor_params_unchanged(desc, expected_value):
    params = extract_parameters(desc, "WEERSTANDEN")
    assert params.get("value") == expected_value


# ---------------------------------------------------------------------------
# ERP-side parsers use the same helpers
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("desc, farads, voltage", [
    ("C0G 330pF 5% 50V 0603", 330e-12, "50V"),
    ("C0G 3,3PF +/-0,25P 50V 0402", 3.3e-12, "50V"),
    ("X5R 4,7UF 10% 6V3 0805", 4.7e-6, "6.3V"),
    ("X7R 470PF 10% 2KV 1206 C1206C471KGRACTU KEMET", 470e-12, "2000V"),
    ("Y5V 1uF -80/+20% 50V 0805", 1e-6, "50V"),
])
def test_parse_condensatoren(desc, farads, voltage):
    p = parse_condensatoren(desc)
    assert normalize_capacitance(p.get("capacitance")) == pytest.approx(farads, rel=1e-9)
    assert p.get("voltage") == voltage


@pytest.mark.parametrize("desc, farads, voltage", [
    ("ELCO 3U3 100V 20% 105C CASE-E SMD EEV-HD", 3.3e-6, "100V"),
    ("TANT 22uF 10% 6V3 CASE-B TPSB AVX", 22e-6, "6.3V"),
    ("ELCO 0,22F 20% 5V RAD EECS0HD224H PAN", 0.22, "5V"),
])
def test_parse_elcos(desc, farads, voltage):
    p = parse_elcos(desc)
    assert normalize_capacitance(p.get("capacitance")) == pytest.approx(farads, rel=1e-9)
    assert p.get("voltage") == voltage
