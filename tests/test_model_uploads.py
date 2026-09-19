"""Upload/export checks against the supplied Rail and SHM artifacts; no training."""
import hashlib
import io
from pathlib import Path
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import app as api

FIXTURES = ROOT / 'tests/fixtures/recordings'
SHM = (FIXTURES / 'shm-stress.csv').read_bytes()


@pytest.fixture(autouse=True)
def isolated_recordings():
    api.recording_jobs.clear()
    yield
    api.recording_jobs.clear()


@pytest.fixture
def client():
    with TestClient(api.app) as client:
        yield client


@pytest.fixture
def rail_csv():
    lines = (FIXTURES / 'rail-first-samples.csv').read_bytes().splitlines()
    return b'\n'.join([lines[0]] + [lines[1 + i % (len(lines) - 1)] for i in range(10000)]) + b'\n'


def analyse(client, subsystem, raw=SHM, name='sample.csv'):
    response = client.post(f'/api/{subsystem}/predict', files={'file': (name, raw, 'text/csv')})
    assert response.status_code == 200, response.text
    return response.json()


def test_shm_inference_exports_and_preserves_supplied_files(client):
    paths = [ROOT / 'backend/shm/shm_model.joblib', ROOT / 'backend/shm/shm_predictions.csv']
    before = [path.read_bytes() for path in paths]
    result = analyse(client, 'shm')
    assert result['prediction'] == 4.1241998628178083e-11
    assert result['summary'] == {'rows': 4}
    assert result['evidence']['cycles'] == 1
    assert result['model_id'] == '846414f389b411539d741fd79e52709422e5a111b7df051dde58d4a08956a609'
    assert result['source_sha256'] == hashlib.sha256(SHM).hexdigest()
    csv = client.get(result['downloads']['csv'])
    assert csv.content == b'file_id,prediction\nsample.csv,4.1241998628178083e-11\n'
    assert csv.headers['cache-control'] == 'no-store'
    with zipfile.ZipFile(io.BytesIO(client.get(result['downloads']['zip']).content)) as archive:
        assert archive.namelist() == ['shm_predictions.csv']
        assert archive.read('shm_predictions.csv') == csv.content
    assert [path.read_bytes() for path in paths] == before
    with_header = analyse(client, 'shm', b'Stress\n' + SHM)
    assert with_header['prediction'] == result['prediction']
    assert any('header' in warning for warning in with_header['warnings'])


def test_rail_inference_headerless_parity_and_subsystem_isolation(client, rail_csv):
    path = ROOT / 'backend/rail_corrugation/rail_model.joblib'
    before = path.read_bytes()
    result = analyse(client, 'rail', rail_csv, 'Test1.csv')
    assert result['prediction'] in ['Normal', 'Side I', 'Side II']
    assert result['summary'] == {'rows': 10000}
    assert result['evidence']['speed_kmh'] == 0
    assert set(result['evidence']['probabilities']) == {'Normal', 'Side I', 'Side II'}
    assert result['model_id'] == '41cbf2934072b18a75cc90e5227cb75041b8ea40815dd6622762322ff81b1336'
    plain = analyse(client, 'rail', rail_csv.split(b'\n', 1)[1], 'Test2.csv')
    assert plain['prediction'] == result['prediction']
    assert plain['evidence'] == result['evidence']
    expected = f'file_id,prediction\nTest1.csv,{result["prediction"]}\n'.encode()
    assert client.get(result['downloads']['csv']).content == expected
    with zipfile.ZipFile(io.BytesIO(client.get(result['downloads']['zip']).content)) as archive:
        assert archive.namelist() == ['rail_predictions.csv']
        assert archive.read('rail_predictions.csv') == expected
    assert client.get(f'/api/shm/jobs/{result["job_id"]}/predictions.csv').status_code == 404
    assert client.post('/api/shm/export', json={'job_ids': [result['job_id']], 'format': 'csv'}).status_code == 404
    assert path.read_bytes() == before


@pytest.mark.parametrize('subsystem,raw,detail', [
    ('shm', b'', 'non-empty'),
    ('shm', b'stress\n', '4 finite'),
    ('shm', b'1\n2\n3\n', '4 finite'),
    ('shm', b'1\n2\nbad\n4\n', 'non-numeric'),
    ('shm', b'1\n2\ninf\n4\n', 'finite'),
    ('shm', b'1,2\n3,4\n', 'one stress column'),
    ('rail', b'', 'non-empty'),
    ('rail', b'file_id,prediction\nTest1.csv,Normal\n', '128'),
    ('rail', (FIXTURES / 'rail-first-samples.csv').read_bytes(), '1024'),
])
def test_bad_recordings_return_actionable_errors_without_results(client, subsystem, raw, detail):
    response = client.post(f'/api/{subsystem}/predict', files={'file': ('test.csv', raw, 'text/csv')})
    assert response.status_code == 422, response.text
    assert detail in response.json()['detail']
    assert not api.recording_jobs


@pytest.mark.parametrize('change,detail', [('speed', '0/1'), ('missing', 'finite'), ('text', 'numeric')])
def test_rail_rejects_invalid_sensor_values(client, rail_csv, change, detail):
    header, rest = rail_csv.split(b'\n', 1)
    first, remaining = rest.split(b'\n', 1)
    cells = first.split(b',')
    cells[0 if change == 'speed' else 1] = {'speed': b'3', 'missing': b'', 'text': b'invalid'}[change]
    raw = header + b'\n' + b','.join(cells) + b'\n' + remaining
    response = client.post('/api/rail/predict', files={'file': ('test.csv', raw, 'text/csv')})
    assert response.status_code == 422, response.text
    assert detail in response.json()['detail']
    assert not api.recording_jobs


def test_combined_export_preserves_order_and_rejects_duplicates(client):
    one = analyse(client, 'shm', name='test01.csv')
    two = analyse(client, 'shm', name='test02.csv')
    ids = [two['job_id'], one['job_id']]
    response = client.post('/api/shm/export', json={'job_ids': ids, 'format': 'csv'})
    assert response.content == b'file_id,prediction\ntest02.csv,4.1241998628178083e-11\ntest01.csv,4.1241998628178083e-11\n'
    zipped = client.post('/api/shm/export', json={'job_ids': ids, 'format': 'zip'})
    with zipfile.ZipFile(io.BytesIO(zipped.content)) as archive:
        assert archive.namelist() == ['shm_predictions.csv']
        assert archive.read('shm_predictions.csv') == response.content
    duplicate = analyse(client, 'shm', name='test01.csv')
    for invalid in ([one['job_id'], one['job_id']], [one['job_id'], duplicate['job_id']]):
        assert client.post('/api/shm/export', json={'job_ids': invalid, 'format': 'csv'}).status_code == 422
    assert client.post('/api/shm/export', json={'job_ids': [], 'format': 'csv'}).status_code == 422
    assert client.post('/api/shm/export', json={'job_ids': ['missing'], 'format': 'csv'}).status_code == 404


def test_completed_test_sets_fit_in_result_cache(client):
    assert api.MAX_RECORDING_JOBS >= 84  # Supplied Rail (68 files) + SHM (16 files).
    results = [analyse(client, 'shm', name=f'test{i}.csv') for i in range(84)]
    assert client.get(results[0]['downloads']['csv']).status_code == 200
    response = client.post('/api/shm/export', json={'job_ids': [r['job_id'] for r in results], 'format': 'csv'})
    assert response.status_code == 200
    assert len(response.content.splitlines()) == 85


def test_expiry_and_eviction_are_reported(client, monkeypatch):
    monkeypatch.setattr(api, 'MAX_RECORDING_JOBS', 1)
    first = analyse(client, 'shm')
    latest = analyse(client, 'shm')
    assert client.get(first['downloads']['csv']).status_code == 404
    created = api.recording_jobs[latest['job_id']][0]
    monkeypatch.setattr(api.time, 'time', lambda: created + api.JOB_TTL_SECONDS + 1)
    response = client.get(latest['downloads']['csv'])
    assert response.status_code == 404
    assert 'Re-analyse' in response.json()['detail']


def test_missing_new_model_dependency_does_not_break_door(client, monkeypatch):
    api.recording_model.cache_clear()
    def unavailable(name):
        raise ModuleNotFoundError('Missing model dependency')
    with monkeypatch.context() as context:
        context.setattr(api.importlib, 'import_module', unavailable)
        response = client.post('/api/shm/predict', files={'file': ('test.csv', SHM, 'text/csv')})
        assert response.status_code == 503
        assert 'backend/requirements.txt' in response.json()['detail']
        assert not api.recording_jobs
    assert client.get('/api/door/model').status_code == 200


def test_upload_extension_and_size_checked_before_model(client, monkeypatch):
    response = client.post('/api/shm/predict', files={'file': ('model.joblib', b'bad', 'application/octet-stream')})
    assert response.status_code == 422
    monkeypatch.setattr(api, 'MAX_UPLOAD', 2)
    response = client.post('/api/rail/predict', files={'file': ('test.csv', b'abc', 'text/csv')})
    assert response.status_code == 413
    assert not api.recording_jobs
