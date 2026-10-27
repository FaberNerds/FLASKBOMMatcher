"""
Settings -> Logging: the live log viewer (whitelisted files, whole lines,
offsets, recreated files, exempt from the rate limit) and the security audit
history (run, list, lookup, CSRF, failures, merged duplicate advisories).

The OSV API is never called: _query_osv / requests are patched and reports
go to a temporary folder.
"""
import re
from unittest import mock

import pytest
import requests

import config

# Importing the app runs its startup work: upload cleanup and logging to
# server.log (production mode), klant cache and parameter index from the ERP
# database. None of that belongs in a test run.
with mock.patch.object(config, 'DEBUG_MODE', True), \
        mock.patch('services.klant_cache_service.ensure_loaded'), \
        mock.patch('services.category_index_service.build_index', return_value={}):
    from app import app, limiter

from routes import logging_api
from services import vulnerability_audit_service


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


@pytest.fixture
def server_log(tmp_path, monkeypatch):
    """Point the 'server' log at a temporary file."""
    path = tmp_path / 'server.log'
    monkeypatch.setitem(logging_api.LOG_VIEWER_FILES, 'server', path)
    return path


@pytest.fixture
def audit_dir(tmp_path, monkeypatch):
    """Store audit reports in a temporary folder and fake the OSV lookup."""
    folder = tmp_path / 'security_audit'
    monkeypatch.setattr(config, 'SECURITY_AUDIT_FOLDER', folder)
    monkeypatch.setattr(vulnerability_audit_service, '_query_osv', lambda packages: [])
    return folder


# ---------------------------------------------------------------------------
# Log viewer
# ---------------------------------------------------------------------------

def test_settings_page_has_logging_card(client):
    html = client.get('/settings').get_data(as_text=True)
    assert '<h3 class="card-title">Logging</h3>' in html
    for name in ('server', 'stdout', 'stderr'):
        assert f'data-log="{name}"' in html
    assert 'id="btnSecurityAudit"' in html


def test_viewer_page_for_known_log(client):
    response = client.get('/settings/logs/server')
    assert response.status_code == 200
    assert b'server.log' in response.data


def test_log_paths_are_absolute_config_paths():
    """The viewer reads exactly the files the app and the service write."""
    assert logging_api.LOG_VIEWER_FILES == {
        'server': config.LOG_FILE,
        'stdout': config.SERVICE_STDOUT_LOG,
        'stderr': config.SERVICE_STDERR_LOG,
    }
    assert all(p.is_absolute() for p in logging_api.LOG_VIEWER_FILES.values())


@pytest.mark.parametrize('name', ['unknown', 'config', '..%2Fconfig.py', '..%2F..%2Fapp.py', 'server.log'])
def test_unknown_log_is_404(client, name):
    assert client.get(f'/settings/logs/{name}').status_code == 404
    assert client.get(f'/api/logs/{name}/tail').status_code == 404


def test_missing_file(client, server_log):
    data = client.get('/api/logs/server/tail').get_json()
    assert data['success'] and not data['exists'] and data['text'] == ''


def test_returns_whole_lines_and_continues_from_offset(client, server_log):
    server_log.write_bytes(b'line 1\nline 2\npartial')
    first = client.get('/api/logs/server/tail').get_json()
    assert first['text'] == 'line 1\nline 2\n'
    assert first['offset'] == len(b'line 1\nline 2\n')

    with open(server_log, 'ab') as f:
        f.write(b' line 3\nline 4\n')
    second = client.get(f"/api/logs/server/tail?offset={first['offset']}").get_json()
    assert second['text'] == 'partial line 3\nline 4\n'
    assert not second['reset']

    third = client.get(f"/api/logs/server/tail?offset={second['offset']}").get_json()
    assert third['text'] == '' and third['offset'] == second['offset']


def test_shrunk_file_resets(client, server_log):
    server_log.write_bytes(b'a' * 100 + b'\n')
    offset = client.get('/api/logs/server/tail').get_json()['offset']

    server_log.write_bytes(b'rotated\n')  # e.g. RotatingFileHandler started a new file
    data = client.get(f'/api/logs/server/tail?offset={offset}').get_json()
    assert data['reset'] and data['text'] == 'rotated\n'


def test_tail_is_exempt_from_rate_limit(client, server_log, audit_dir):
    """The viewer polls every 1.5 s per open window; the default limit is 300 per minute."""
    server_log.write_bytes(b'x\n')
    was_enabled = limiter.enabled
    limiter.enabled = True
    limiter.reset()
    try:
        tail = {client.get('/api/logs/server/tail?offset=2').status_code for _ in range(320)}
        reports = {client.get('/api/security-audit/reports').status_code for _ in range(320)}
        # Control: a normal endpoint does hit the default limit
        other = {client.get('/health').status_code for _ in range(320)}
    finally:
        limiter.reset()
        limiter.enabled = was_enabled
    assert tail == {200}
    assert reports == {200}
    assert 429 in other


# ---------------------------------------------------------------------------
# Security audit
# ---------------------------------------------------------------------------

def test_audit_page(client):
    response = client.get('/settings/security-audit')
    assert response.status_code == 200
    assert b'name="csrf-token"' in response.data


def test_run_list_and_get(client, audit_dir):
    assert client.get('/api/security-audit/reports').get_json()['reports'] == []

    response = client.post('/api/security-audit/run', json={})
    assert response.status_code == 200
    report = response.get_json()['report']
    assert report['status'] == 'ok' and report['vulnerability_count'] == 0
    assert report['package_count'] > 0 and report['trigger'] == 'manual'

    reports = client.get('/api/security-audit/reports').get_json()['reports']
    assert [r['id'] for r in reports] == [report['id']]
    assert client.get(f"/api/security-audit/reports/{report['id']}").status_code == 200
    assert list(audit_dir.glob('audit_*.json'))


def test_run_passes_csrf_outside_testing_mode(client, audit_dir):
    """The window's request (JSON + X-CSRFToken from its meta tag) is accepted;
    a form post without the token is refused."""
    app.config['TESTING'] = False
    try:
        html = client.get('/settings/security-audit').get_data(as_text=True)
        token = re.search(r'name="csrf-token" content="([^"]+)"', html).group(1)

        response = client.post('/api/security-audit/run', data='{}',
                               headers={'Content-Type': 'application/json', 'X-CSRFToken': token})
        assert response.status_code == 200

        assert client.post('/api/security-audit/run').status_code == 400
        assert client.post('/api/security-audit/run', headers={'X-CSRFToken': token}).status_code == 200
    finally:
        app.config['TESTING'] = True


@pytest.mark.parametrize('report_id', ['abc', '..%2F..%2Fconfig', '20990101_000000'])
def test_bad_report_id_is_404(client, audit_dir, report_id):
    assert client.get(f'/api/security-audit/reports/{report_id}').status_code == 404


def test_concurrent_run_is_409(client, audit_dir):
    vulnerability_audit_service._run_lock.acquire()
    try:
        assert client.post('/api/security-audit/run', json={}).status_code == 409
    finally:
        vulnerability_audit_service._run_lock.release()


def test_failed_lookup_is_saved_as_error(audit_dir, monkeypatch):
    def offline(packages):
        raise requests.ConnectionError('no network')
    monkeypatch.setattr(vulnerability_audit_service, '_query_osv', offline)

    report = vulnerability_audit_service.run_audit('scheduled')
    assert report['status'] == 'error' and 'no network' in report['error']
    assert vulnerability_audit_service.list_reports()[0]['status'] == 'error'


def test_aliased_advisories_are_merged(monkeypatch):
    """A GHSA and a PYSEC entry for the same CVE count as one finding."""
    vulns = {
        'GHSA-aaaa': {'aliases': ['CVE-2026-1', 'PYSEC-2026-1'],
                      'database_specific': {'severity': 'HIGH'}, 'summary': 'bad',
                      'affected': [{'package': {'name': 'demo'},
                                    'ranges': [{'events': [{'introduced': '0'}, {'fixed': '2.0'}]}]}]},
        'PYSEC-2026-1': {'aliases': ['CVE-2026-1', 'GHSA-aaaa']},
        'PYSEC-2026-2': {'aliases': ['CVE-2026-1']},  # Shares only the CVE
    }

    class Resp:
        def __init__(self, data):
            self.data = data

        def raise_for_status(self):
            pass

        def json(self):
            return self.data

    monkeypatch.setattr(vulnerability_audit_service.requests, 'post', lambda *a, **k: Resp(
        {'results': [{'vulns': [{'id': i} for i in vulns]}]}))
    monkeypatch.setattr(vulnerability_audit_service.requests, 'get', lambda url, **k: Resp(
        vulns[url.rsplit('/', 1)[-1]]))

    findings = vulnerability_audit_service._query_osv([{'name': 'demo', 'version': '1.0'}])
    assert len(findings) == 1
    assert findings[0]['id'] == 'GHSA-aaaa'
    assert findings[0]['cves'] == ['CVE-2026-1']
    assert findings[0]['severity'] == 'HIGH'
    assert findings[0]['fixed_versions'] == ['2.0']


def test_scheduler_is_not_started_at_import():
    """Tests import the app; only the service and the dev server start the daily audit."""
    assert not vulnerability_audit_service._scheduler_started
