"""
Match page row panel: /api/match/set-row (Remove match, Use, Accept, Undo) and
the preview mode of /api/match/manual-search that leaves the stored match alone.

The session store and the ERP search are replaced by in-memory fakes.
"""
from unittest import mock

import pytest

import config

with mock.patch.object(config, 'DEBUG_MODE', True), \
        mock.patch('services.klant_cache_service.ensure_loaded'), \
        mock.patch('services.category_index_service.build_index', return_value={}):
    from app import app

from routes import match_api


@pytest.fixture
def store(monkeypatch):
    data = {
        'bom': {'rows': [{'Desc': 'CAP 4U7 10V 0603'}, {'Desc': 'RES 4K7 0805'}], 'klant_nr': ''},
        'matches': {'0': {'row_index': 0, 'search_method': 'description', 'confidence': 'low',
                          'suggestions': [{'FaberNr': '311420'}], 'auto_selected': {'FaberNr': '311420'}}},
        'selections': {'0': {'mpnfree': True}},
    }
    monkeypatch.setattr(match_api, 'load_bom_data', lambda: data['bom'])
    monkeypatch.setattr(match_api, 'load_matches', lambda: dict(data['matches']))
    monkeypatch.setattr(match_api, 'save_matches', lambda m: data.__setitem__('matches', m))
    monkeypatch.setattr(match_api, 'load_selections', lambda: dict(data['selections']))
    monkeypatch.setattr(match_api, 'save_selections', lambda s: data.__setitem__('selections', s))
    return data


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def test_set_row_stores_match_and_selection(client, store):
    match = {'search_method': 'manual', 'confidence': 'none',
             'suggestions': [{'FaberNr': '311488'}], 'auto_selected': None}
    response = client.post('/api/match/set-row', json={
        'row_index': 1, 'match': match, 'selection': {'fabernr': '311488', 'other': 'dropped'}})
    assert response.status_code == 200
    assert store['matches']['1']['suggestions'] == [{'FaberNr': '311488'}]
    assert store['matches']['1']['row_index'] == 1
    assert store['selections']['1'] == {'fabernr': '311488'}
    # The other line is untouched
    assert store['matches']['0']['auto_selected'] == {'FaberNr': '311420'}


def test_set_row_null_removes_entries(client, store):
    response = client.post('/api/match/set-row', json={'row_index': 0, 'match': None, 'selection': None})
    assert response.status_code == 200
    assert '0' not in store['matches']
    assert '0' not in store['selections']


@pytest.mark.parametrize('body', [
    {'match': None},
    {'row_index': '0'},
    {'row_index': True},
    {'row_index': 5},
    {'row_index': -1},
    {'row_index': 0, 'match': [1, 2]},
    {'row_index': 0, 'selection': 'x'},
])
def test_set_row_rejects_bad_input(client, store, body):
    assert client.post('/api/match/set-row', json=body).status_code == 400
    assert '0' in store['matches']


def test_manual_search_preview_leaves_the_match(client, store, monkeypatch):
    monkeypatch.setattr(match_api.search_service, 'search_by_mpn', lambda q: [{'FaberNr': '311999'}])
    monkeypatch.setattr(match_api, 'filter_customer_specific', lambda s, k: s)

    data = client.post('/api/match/manual-search', json={
        'row_index': 0, 'search_type': 'mpn', 'query': 'CL10', 'preview': True}).get_json()
    assert data['suggestions'] == [{'FaberNr': '311999'}]
    assert store['matches']['0']['auto_selected'] == {'FaberNr': '311420'}

    # Without preview the search still replaces the stored match, as before
    client.post('/api/match/manual-search', json={'row_index': 0, 'search_type': 'mpn', 'query': 'CL10'})
    assert store['matches']['0']['auto_selected'] == {'FaberNr': '311999'}
