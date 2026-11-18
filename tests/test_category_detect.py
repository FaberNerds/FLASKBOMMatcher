"""
Component type detection (category_detect_service): keywords first, then the refdes letter,
then the units. The problem lines come from real customer BOMs where checking the units first
went wrong (a coil's "0.116Ohm DCR" read as a resistor, "170MHz" as a henry, a crystal's
"12.5pF" as a capacitor).
"""
import pytest

from services.category_detect_service import (
    component_group, detect_category, is_generic_rc, refdes_number, refdes_prefix,
)

R, C, ELCO, L = "WEERSTANDEN", "CONDENSATOREN", "ELCO'S en TANTALEN", "SPOELEN en SUPPRESSORS"
D, Q, IC, XTAL = "DIODEN EN DIAC'S", "TRANSISTOREN en FETS", "INTEGRATED CIRCUITS", "KRISTALLEN en OSCILLATOREN"


@pytest.mark.parametrize('description, refdes, expected', [
    # Went wrong before: a value in the description of another part type
    ('Inductor Power Shielded Wirewound 2.2uH 20% 1MHz Metal 1.8A 0.116Ohm DCR 0806', '', L),
    ('22 µH Unshielded Inductor 4.5 A 66mOhm Max Nonstandard', '', L),
    ('Multilayer Inductor, 3 nH, 0.125 ohm, 6 GHz, 800 mA, 0402 [1005 Metric]', '', L),
    ('Ferrite Beads Multi-Layer 600Ohm 25% 100MHz 500mA 350mOhm DCR 0603', '', L),
    ('70R/100MHz 0.4A 25% 25% FER1206 70Z', '', L),
    ('SMT Common Mode Line Filter 1210', '', L),
    ('MCU STM32G4 ARM Cortex-M4 170MHz 512kB Flash LQFP-100', '', IC),
    ('EEPROM 8Kbit SPI 20MHz SOIC-8 2.5V 5.5V', '', IC),
    ('Opamp 5.5V 1MHz MCP6006UT-E/OT', '', IC),
    ('Crystal 32.768kHz CM8V-T1A-32.768kHz-12.5pF-20PPM', '', XTAL),
    ('CRYSTAL 30.72MHZ 10PF 3.2x2.5', '', XTAL),
    ('MMSZ Series 15 V 500 mW ±5 % 16 Ohm Surface Mount Zener Diode - SOD-123', '', D),
    ('DIODE ZENER 5.6V 500MW SOD123 40Ohm', '', D),
    ('MOSFET N ch Power-Transistor 40V, 180A, 1.1mOhm IPB180N04S4H0', '', Q),
    ('PMOSFET, 89A, 20V, 900mV, 4mR DMP2005UFG-13', '', Q),
    ('BJT PNP SMD 150V 500mA 5V 300MHz SOT-323', '', Q),
    ('PANASONIC ELECTRONIC COMPONENTS ERJ-P06J103V RES, THICK FILM', '', R),
    # The refdes decides when the description does not
    ('3,3V 0.2pF 20kV 30W 0402 DFN', 'D400, D500', D),
    ('Generic Capacitor', 'C1', C),
    ('Generic Resistor', 'R12', R),
    ('Tranceiver Module, 433MHz, +13dbm RFM300W', 'U4', IC),
    ('LT3420-1 - Photoflash Capacitor Chargers with Automatic Refresh', 'U3', IC),
    ('100uF 25V', 'C5', C),
    ('100uF 25V elco', 'C5', ELCO),
    # The usual lines keep their category
    ('RES 10K 0603', '', R),
    ('Res Thick Film 0805 150K 5% 1/4W', '', R),
    ('WEERST 4K7 5% 0805 0,125W', '', R),
    ('4K7 5% 0805', '', R),
    ('10K 1% 0603', '', R),
    ('100 Ohm 1% 0603', '', R),
    ('CAP 100nF X7R 0603', '', C),
    ('4,7uF 10V X5R 0603', '', C),
    ('CER0805 100N 50V', '', C),
    ('100nF 50V 0603', '', C),
    ('Cap Aluminum Lytic 1000uF 25V 20%', '', ELCO),
    ('ELCO 100uF 25V', '', ELCO),
    ('CONN PR 4p THT 691312710004 WURTH', '', "CONNECTOREN/PLUGGEN"),
    ('LED RED 0603', '', "LED / OPTO'S"),
    ('', 'L3', L),
    ('', '', None),
    ('Something unknown', '', None),
])
def test_detect_category(description, refdes, expected):
    assert detect_category(description, refdes) == expected


@pytest.mark.parametrize('description, refdes', [
    ('Thermistor, NTC, SMD 0603, 1% 10k', 'R7'),
    ('RES NTC SMD 100kΩ 2% 4100K 0402', 'RT1'),
    ('Varistor 14V 0603', 'RV1'),
])
def test_special_resistors_are_not_searched_as_plain_resistors(description, refdes):
    category = detect_category(description, refdes)
    assert category is None
    assert not is_generic_rc(category)


def test_coils_are_no_longer_mpnfree_candidates():
    assert not is_generic_rc(detect_category('Inductor Power Shielded 4.7uH 20% 1MHz 2.1A 0.22Ohm DCR'))


def test_refdes_helpers():
    assert refdes_prefix('R12, R13') == 'R'
    assert refdes_prefix('FB3') == 'FB'
    assert refdes_prefix('') == ''
    assert refdes_number('C12, C3, C204') == 3
    assert refdes_number('R1-R4') == 1
    assert refdes_number('') is None
    assert refdes_number('J') is None


@pytest.mark.parametrize('category, group', [
    (R, 'resistor'), (C, 'capacitor'), (ELCO, 'capacitor'), (L, 'inductor'), (D, 'other'), (None, 'other'),
])
def test_component_group(category, group):
    assert component_group(category) == group
