"""
Find IPN auto-selection: only an identical MPN (or FaberNr) is assigned automatically.
A different MPN (packaging suffix, longer/shorter part number, fuzzy old-BOM match) is
only a suggestion. Description and parameter matches keep their own rules.

The ERP is never queried: the search functions are replaced by fakes.
"""
import pytest

from services import match_service, previous_bom_match_service
from services.mpn_normalize_service import mpn_identical, search_with_variants_batched


def erp(fabernr, mpn, status='Actief', stock=10, cost=0.01):
    return {'FaberNr': fabernr, 'MPN': mpn, 'Omschrijving': f'PART {mpn}', 'Status': status,
            'Voorraad': stock, 'Kostprijs': cost, 'Manufacturer': ''}


@pytest.mark.parametrize('a, b, same', [
    ('RC0603FR-0710KL', 'RC0603FR-0710KL', True),
    ('rc0603fr-0710kl', 'RC0603FR-0710KL', True),
    ('TB(LF)', 'TB (LF)', True),
    ('RC0603FR-0710KL', 'RC0603FR-0710KL-TR', False),
    ('BC847B', 'BC847B,215', False),
    ('RC0603FR-0710KL', 'RC0603FR0710KL', False),
    ('', '', False),
])
def test_mpn_identical(a, b, same):
    assert mpn_identical(a, b) is same


def test_variant_search_marks_only_the_identical_mpn_exact():
    hits = [erp('1', 'GRM188R61A475KE15D-TR'), erp('2', 'GRM188R61A475KE15D')]
    results = search_with_variants_batched('GRM188R61A475KE15D', lambda variants: [dict(h) for h in hits])
    exact = {r['FaberNr']: r['_exact_match'] for r in results}
    assert exact == {'1': False, '2': True}


def _mpn_search(monkeypatch, hits):
    monkeypatch.setattr(match_service, 'search_with_variants_batched',
                        lambda mpn, fn: search_with_variants_batched(mpn, lambda v: [dict(h) for h in hits]))
    monkeypatch.setattr(match_service, 'get_mpn_highlights', lambda mpn, desc: [])


def test_different_mpn_is_a_suggestion_only(monkeypatch):
    _mpn_search(monkeypatch, [erp('311420', 'CL10A475KQ8NNNC-TR')])
    result = match_service._search_row_by_mpn(0, 'CL10A475KQ8NNNC')
    assert result['auto_selected'] is None
    assert result['confidence'] == 'medium'
    assert result['display_suggestion']['FaberNr'] == '311420'


def test_identical_mpn_is_assigned_even_when_ranked_lower(monkeypatch):
    # The in-stock, cheaper article with another MPN would rank first on its own
    _mpn_search(monkeypatch, [erp('1', 'CL10A475KQ8NNNC-TR', stock=500, cost=0.001),
                              erp('2', 'CL10A475KQ8NNNC', stock=0, cost=0.05)])
    result = match_service._search_row_by_mpn(0, 'CL10A475KQ8NNNC')
    assert result['confidence'] == 'high'
    assert result['auto_selected']['FaberNr'] == '2'
    assert result['suggestions'][0]['FaberNr'] == '2'


def test_ipn_is_assigned_only_when_identical(monkeypatch):
    monkeypatch.setattr(match_service.search_service, 'search_by_ipn', lambda ipn: [erp('3114200', 'X')])
    other = match_service._search_row_by_ipn(0, '311420')
    assert other['auto_selected'] is None
    assert other['display_suggestion']['FaberNr'] == '3114200'

    monkeypatch.setattr(match_service.search_service, 'search_by_ipn',
                        lambda ipn: [erp('3114200', 'X'), erp('311420', 'Y')])
    same = match_service._search_row_by_ipn(0, '311420')
    assert same['auto_selected']['FaberNr'] == '311420'


def test_description_match_is_still_assigned(monkeypatch):
    monkeypatch.setattr(match_service.search_service, 'search_by_description', lambda terms: [erp('304880', '')])
    result = match_service._search_row_by_description(0, ['RES', '4K7'])
    assert result['auto_selected']['FaberNr'] == '304880'


def _previous_bom(monkeypatch, old_mpn, erp_mpn):
    previous = [{'FaberNr': '402230', 'MPN': old_mpn, 'Description': 'MCU STM32G071', 'Manufacturer': 'ST'}]
    monkeypatch.setattr(previous_bom_match_service.search_service, 'search_by_item_codes',
                        lambda codes: [erp('402230', erp_mpn)])
    row = {'MPN': 'STM32G071K8T6', 'Desc': 'MCU'}
    mapping = {'MPN': 'MPN', 'Description': 'Desc'}
    return previous_bom_match_service.match_previous_single(0, row, mapping, previous)


def test_previous_bom_fuzzy_mpn_is_a_suggestion_only(monkeypatch):
    result = _previous_bom(monkeypatch, 'STM32G071K8T6TR', 'STM32G071K8T6TR')
    assert result['auto_selected'] is None
    assert result['confidence'] == 'medium'
    assert result['display_suggestion']['FaberNr'] == '402230'


def test_previous_bom_identical_mpn_is_reused(monkeypatch):
    result = _previous_bom(monkeypatch, 'STM32G071K8T6', 'STM32G071K8T6')
    assert result['confidence'] == 'high'
    assert result['auto_selected']['FaberNr'] == '402230'
