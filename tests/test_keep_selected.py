"""
An article picked by hand keeps its details when Find IPN replaces the row's match
(match_service.keep_selected_articles). Before, the row showed "Matched" but stayed empty,
and a search listed the article as "In use". The ERP lookup is a fake.
"""
from unittest import mock

import pytest

import config

with mock.patch.object(config, 'DEBUG_MODE', True), \
        mock.patch('services.klant_cache_service.ensure_loaded'), \
        mock.patch('services.category_index_service.build_index', return_value={}):
    from app import app

from routes import upload_api
from services import match_service

ERP = {
    '62098900': {'FaberNr': '62098900', 'Omschrijving': 'IC AEM15820 E-PEAS QFN-40', 'MPN': 'AEM15820'},
    '311420': {'FaberNr': '311420', 'Omschrijving': 'CAP 4U7', 'MPN': 'CL10A475KQ8NNNC'},
}


@pytest.fixture
def erp_lookup(monkeypatch):
    calls = []

    def fake(codes):
        calls.append(list(codes))
        return [dict(ERP[c]) for c in codes if c in ERP]

    monkeypatch.setattr(match_service.search_service, 'search_by_item_codes', fake)
    return calls


def test_a_missing_hand_picked_article_is_put_back(erp_lookup):
    matches = {'0': {'row_index': 0, 'search_method': 'mpn', 'confidence': 'medium',
                     'suggestions': [{'FaberNr': '35585000'}], 'auto_selected': None}}
    changed = match_service.keep_selected_articles(matches, {'0': {'fabernr': '62098900', 'mpnfree': False}})
    assert changed == ['0']
    assert [s['FaberNr'] for s in matches['0']['suggestions']] == ['62098900', '35585000']
    assert matches['0']['suggestions'][0]['Omschrijving'] == 'IC AEM15820 E-PEAS QFN-40'


def test_nothing_is_fetched_when_the_article_is_there(erp_lookup):
    matches = {'0': {'suggestions': [{'FaberNr': '311420'}]}}
    assert match_service.keep_selected_articles(matches, {'0': {'fabernr': '311420'}, '1': {'mpnfree': True}}) == []
    assert erp_lookup == []


def test_a_row_without_match_gets_one(erp_lookup):
    matches = {}
    assert match_service.keep_selected_articles(matches, {'4': {'fabernr': '311420'}}) == ['4']
    assert matches['4']['suggestions'][0]['FaberNr'] == '311420'
    assert matches['4']['auto_selected'] is None


def test_an_unknown_article_is_left_alone(erp_lookup):
    matches = {'0': {'suggestions': []}}
    assert match_service.keep_selected_articles(matches, {'0': {'fabernr': '99999999'}}) == []
    assert matches['0']['suggestions'] == []


def test_bom_data_repairs_a_session(erp_lookup, monkeypatch):
    store = {'matches': {'0': {'row_index': 0, 'search_method': 'mpn', 'confidence': 'medium',
                               'suggestions': [], 'auto_selected': None}}}
    bom = {'name': 'x.xlsx', 'rows': [{'D': 'AEM15820 Boost', 'Ref': 'U5'}],
           'column_mapping': {'Description': 'D', 'Refdes': 'Ref'}}
    monkeypatch.setattr(upload_api, 'load_bom_data', lambda: bom)
    monkeypatch.setattr(upload_api, 'load_matches', lambda: store['matches'])
    monkeypatch.setattr(upload_api, 'save_matches', lambda m: store.__setitem__('saved', m))
    monkeypatch.setattr(upload_api, 'load_selections', lambda: {'0': {'fabernr': '62098900'}})
    monkeypatch.setattr(upload_api, 'load_mpnfree', lambda: {})

    app.config['TESTING'] = True
    with app.test_client() as client:
        data = client.get('/api/bom-data').get_json()
    assert data['matches']['0']['suggestions'][0]['FaberNr'] == '62098900'
    assert store['saved']['0']['suggestions'][0]['FaberNr'] == '62098900'
