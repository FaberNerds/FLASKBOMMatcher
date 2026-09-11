"""
Scoring safety net: a query that lacks its core value (capacitance,
resistance, inductance) must never produce a match, no matter how well the
remaining parameters line up. Without this guard, "16V 0603" alone scored
100% against every 0603 capacitor and auto-selected a random one.
"""

import pytest

from services.category_index_service import CATEGORY_WEIGHTS, CategoryIndex


FULL_CAP = {"capacitance": "330pF", "voltage": "50V", "package": "0603",
            "dielectric": "C0G", "tolerance": "5%"}


def _score(query, candidate, category):
    weights = CATEGORY_WEIGHTS[category.upper()]
    score, _matched = CategoryIndex._compute_score(query, candidate, weights, category)
    return score


@pytest.mark.parametrize("category, query", [
    ("CONDENSATOREN", {"voltage": "16V", "package": "0603"}),
    ("CONDENSATOREN", {"voltage": "50V", "package": "0603", "dielectric": "C0G", "tolerance": "5%"}),
    ("WEERSTANDEN", {"package": "0603", "tolerance": "1%"}),
    ("ELCO'S EN TANTALEN", {"voltage": "16V", "case_size": "CASE-D"}),
    ("SPOELEN EN SUPPRESSORS", {"package": "0603"}),
])
def test_missing_core_value_scores_zero(category, query):
    candidate = {**FULL_CAP, "value": "10K", "inductance": "1uH", "case_size": "CASE-D"}
    assert _score(query, candidate, category) == 0.0


def test_core_guard_is_case_insensitive_on_category():
    query = {"voltage": "16V", "package": "0603"}
    assert _score(query, FULL_CAP, "condensatoren") == 0.0


def test_matching_capacitor_still_scores_full():
    query = {"capacitance": "330pF", "voltage": "16V", "package": "0603"}
    assert _score(query, FULL_CAP, "CONDENSATOREN") == 100.0


def test_shorthand_and_explicit_capacitance_compare_equal():
    query = {"capacitance": "6.8pF", "package": "0402"}
    candidate = {"capacitance": "6.8pF", "voltage": "50V", "package": "0402"}
    assert _score(query, candidate, "CONDENSATOREN") == 100.0


def test_wrong_capacitance_is_disqualifying():
    query = {"capacitance": "68pF", "voltage": "16V", "package": "0603"}
    assert _score(query, FULL_CAP, "CONDENSATOREN") == 0.0


def test_higher_voltage_is_acceptable_and_kilovolt_parses():
    query = {"capacitance": "1nF", "voltage": "2000V", "package": "1206"}
    candidate = {"capacitance": "1nF", "voltage": "2000V", "package": "1206"}
    assert _score(query, candidate, "CONDENSATOREN") == 100.0
    lower = {"capacitance": "1nF", "voltage": "50V", "package": "1206"}
    assert _score(query, lower, "CONDENSATOREN") < 100.0
