"""
Spec search in the row panel: the typed values are read into the index notation
(normalize_spec_query) and /api/match/spec-search checks them before searching.
"""
from unittest import mock

import pytest

import config
from services.category_index_service import normalize_spec_query

with mock.patch.object(config, 'DEBUG_MODE', True), \
        mock.patch('services.klant_cache_service.ensure_loaded'), \
        mock.patch('services.category_index_service.build_index', return_value={}):
    from app import app

from routes import match_api


@pytest.mark.parametrize('typed, expected', [
    ({'value': '20k'}, {'value': '20000'}),
    ({'value': '4K7'}, {'value': '4700'}),
    ({'value': '20K0'}, {'value': '20000'}),
    ({'value': '1M'}, {'value': '1000000'}),
    ({'value': '330mΩ'}, {'value': '0.33'}),
    ({'value': '20Ω'}, {'value': '20'}),
    ({'tolerance': '1'}, {'tolerance': '1%'}),
    ({'tolerance': '0,1%'}, {'tolerance': '0.1%'}),
    ({'power': '62.5mW'}, {'power': '0.0625W'}),
    ({'power': '1/16W'}, {'power': '0.0625W'}),
    ({'power': '0,063W'}, {'power': '0.063W'}),
    ({'package': 'SMD0402'}, {'package': '0402'}),
    ({'voltage': '200'}, {'voltage': '200V'}),
    # A capacitor field is not a resistor field
    ({'dielectric': 'X7R'}, {}),
])
def test_resistor_fields(typed, expected):
    assert normalize_spec_query('WEERSTANDEN', typed) == (expected, [])


@pytest.mark.parametrize('typed, expected', [
    ({'capacitance': '0.1UF'}, {'capacitance': '0.1uF'}),
    ({'capacitance': '4n7'}, {'capacitance': '4.7nF'}),
    ({'capacitance': '100n'}, {'capacitance': '100nF'}),
    ({'dielectric': 'cog'}, {'dielectric': 'C0G'}),
    ({'voltage': '50'}, {'voltage': '50V'}),
    ({'voltage': '6V3'}, {'voltage': '6.3V'}),
    ({'package': '0603'}, {'package': '0603'}),
])
def test_capacitor_fields(typed, expected):
    assert normalize_spec_query('CONDENSATOREN', typed) == (expected, [])


def test_unreadable_fields_are_named():
    params, bad = normalize_spec_query('WEERSTANDEN', {'value': 'abc', 'power': 'lots', 'tolerance': ''})
    assert params == {}
    assert bad == ['value', 'power']


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(match_api, 'load_bom_data', lambda: {
        'rows': [{'Desc': 'Resistor 20k 1% 62.5mW 50V SMD0402', 'Mpn': 'CRG0402F20K'}],
        'column_mapping': {'Description': 'Desc', 'MPN': 'Mpn'},
        'klant_nr': '1120',
    })
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def test_spec_search_passes_normalized_params(client, monkeypatch):
    calls = []

    def fake_search(category, params, **kw):
        calls.append((category, params, kw))
        return [{'FaberNr': '35439700'}]

    monkeypatch.setattr(match_api, 'search_by_spec', fake_search)
    response = client.post('/api/match/spec-search', json={
        'row_index': 0, 'kind': 'RES',
        'params': {'value': '20k', 'tolerance': '1%', 'power': '62.5mW', 'package': '0402'}})
    assert response.status_code == 200
    data = response.get_json()
    assert data['suggestions'] == [{'FaberNr': '35439700'}]
    category, params, kw = calls[0]
    assert category == 'WEERSTANDEN'
    assert params == {'value': '20000', 'tolerance': '1%', 'power': '0.0625W', 'package': '0402'}
    assert kw['description'].startswith('Resistor 20k')
    assert kw['bom_mpn'] == 'CRG0402F20K'
    assert kw['selected_klant_nr'] == '1120'


def test_spec_search_without_the_value(client, monkeypatch):
    # The value may be left out (its field name clicked off): the other fields still search
    calls = []
    monkeypatch.setattr(match_api, 'search_by_spec', lambda category, params, **kw: calls.append(params) or [])
    response = client.post('/api/match/spec-search', json={'kind': 'CAP', 'params': {'voltage': '50V', 'package': '0603'}})
    assert response.status_code == 200
    assert calls == [{'voltage': '50V', 'package': '0603'}]


def test_spec_search_needs_a_field(client, monkeypatch):
    monkeypatch.setattr(match_api, 'search_by_spec', lambda *a, **k: pytest.fail('searched without fields'))
    assert client.post('/api/match/spec-search', json={'kind': 'RES', 'params': {}}).status_code == 400
    response = client.post('/api/match/spec-search', json={'kind': 'RES', 'params': {'voltage': '50V'}})
    assert response.status_code == 400
    assert response.get_json()['fields'] == ['voltage']


def test_spec_search_names_unreadable_fields(client, monkeypatch):
    monkeypatch.setattr(match_api, 'search_by_spec', lambda *a, **k: pytest.fail('searched with a bad field'))
    response = client.post('/api/match/spec-search', json={'kind': 'RES', 'params': {'value': '10k', 'power': 'big'}})
    assert response.status_code == 400
    data = response.get_json()
    assert data['fields'] == ['power']
    assert 'Power' in data['error']


def test_spec_search_rejects_other_kinds(client):
    response = client.post('/api/match/spec-search', json={'kind': 'IND', 'params': {'value': '10uH'}})
    assert response.status_code == 400


def test_resistor_voltage_is_read_from_the_description(monkeypatch):
    """The index has no resistor voltage: a lower stated voltage drops the article, none keeps it."""
    from services import match_service
    seen = {}

    def fake_index(category, params, limit=20, require_core=True, strict=False):
        seen.update(params=params, require_core=require_core, strict=strict)
        return [
            {'item_code': 'A', 'description': 'RES 1K0 1% 0,25W 200V 1206', 'score': 100},
            {'item_code': 'B', 'description': 'RES 1K0 1% 0,25W 1206', 'score': 100},
            {'item_code': 'C', 'description': 'RES 1K0 1% 0,25W 500V 1206', 'score': 100},
            {'item_code': 'D', 'description': 'RES 1K0 1% 0,25W 150V 1206', 'score': 100},
        ]

    monkeypatch.setattr(match_service, 'search_by_parameters', fake_index)
    monkeypatch.setattr(match_service, '_erp_verified',
                        lambda results, *a, **k: [{'FaberNr': r['item_code'], 'Voorraad': 1, 'Kostprijs': 0.01} for r in results])
    out = match_service.search_by_spec('WEERSTANDEN', {'value': '1000', 'voltage': '200V', 'package': '1206'})
    assert sorted(s['FaberNr'] for s in out) == ['A', 'B', 'C']
    assert seen['params'] == {'value': '1000', 'package': '1206'}
    assert seen['require_core'] is False
    assert seen['strict'] is True


def test_strict_scoring_names_the_failed_params():
    """Spec search drops an article outside the spec; one that does not state the param stays."""
    from services.category_index_service import CategoryIndex, CATEGORY_WEIGHTS
    query = {'capacitance': '4.7uF', 'voltage': '16V', 'tolerance': '10%', 'package': '0603'}
    weights = CATEGORY_WEIGHTS['CONDENSATOREN']

    def failed_for(candidate):
        failed = set()
        CategoryIndex._compute_score(query, candidate, weights, 'CONDENSATOREN', True, failed)
        return failed

    base = {'capacitance': '4.7uF', 'tolerance': '10%', 'package': '0603'}
    assert failed_for({**base, 'voltage': '10V'}) == {'voltage'}
    assert failed_for({**base, 'voltage': '25V'}) == set()
    assert failed_for(base) == set()
    assert failed_for({**base, 'voltage': '16V', 'tolerance': '20%'}) == {'tolerance'}
