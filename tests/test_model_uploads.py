"""Upload/export checks against the supplied recording artifacts; no training."""
import hashlib
import io
from pathlib import Path
import sys
import zipfile

import pandas as pd
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


@pytest.fixture
def acv_frame():
    frame = pd.DataFrame({'Time': pd.date_range('2026-01-01', periods=241, freq='30s')})
    for car in range(1, 9):
        prefix = f'Car {car:02d} - '
        frame[prefix + 'Indoor Temperature'] = 28.0 if car == 1 else 25.0
        frame[prefix + 'Control Temperature (Cooling)'] = 24.0
        frame[prefix + 'ACV Running Mode'] = 'Cooling'
        frame[prefix + 'Setting Mode'] = 'Centralized'
    return frame


def analyse(client, subsystem, raw=SHM, name='sample.csv'):
    response = client.post(f'/api/{subsystem}/predict', files={'file': (name, raw, 'text/csv')})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize('origin,allowed', [
    ('http://localhost:5174', True),
    ('http://127.0.0.1:5175', True),
    ('https://localhost:6443', True),
    ('http://localhost.example.com:5174', False),
    ('http://127.0.0.10:5174', False),
])
def test_local_development_ports_support_upload_preflight(client, origin, allowed):
    response = client.options('/api/shm/predict', headers={
        'Origin': origin, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
    })
    assert response.status_code == (200 if allowed else 400)
    assert response.headers.get('access-control-allow-origin') == (origin if allowed else None)


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


def test_acv_ranked_result_evidence_and_exports_match_script(client, acv_frame, tmp_path):
    paths = [ROOT / 'backend/acv/acv_model.joblib', ROOT / 'backend/acv/acv_predictions.csv']
    before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    raw = acv_frame.to_csv(index=False).encode()
    result = analyse(client, 'acv', raw, 'case.csv')
    module, bundle, _ = api.recording_model('acv')
    source = tmp_path / 'case.csv'
    source.write_bytes(raw)
    order, scored = module.predict_file(source, bundle)
    assert result['prediction'] == order == [f'{i:02d}' for i in range(1, 9)]
    assert result['summary'] == {'rows': 241}
    assert result['source_sha256'] == hashlib.sha256(raw).hexdigest()
    assert result['model_id'] == before[0]
    assert result['model_name'] == 'acv-leak-evidence-fusion'
    assert result['evidence']['analysed_rows'] == 241
    assert result['evidence']['dropped_timestamp_rows'] == result['evidence']['duplicate_timestamp_rows'] == 0
    for rank, car in enumerate(result['evidence']['cars'], 1):
        expected = scored.loc[car['car_id']]
        assert car['rank'] == rank
        assert car['probability'] == expected['probability']
        assert car['thermal_deficit_degC'] == expected['TD']
        assert car['valid_minutes'] == expected['valid_minutes']
        assert car['intervention_minutes'] == 0
        assert car['compressor_start_ratio'] is None
    assert 'exactly one' in result['warnings'][0]
    csv = client.get(result['downloads']['csv']).content
    assert csv == b'file_id,ranked_cars\ncase.csv,01|02|03|04|05|06|07|08\n'
    with zipfile.ZipFile(io.BytesIO(client.get(result['downloads']['zip']).content)) as archive:
        assert archive.namelist() == ['acv_predictions.csv']
        assert archive.read('acv_predictions.csv') == csv
    second = analyse(client, 'acv', raw, 'case2.csv')
    combined = client.post('/api/acv/export', json={'job_ids': [second['job_id'], result['job_id']], 'format': 'csv'})
    assert combined.content == b'file_id,ranked_cars\ncase2.csv,01|02|03|04|05|06|07|08\ncase.csv,01|02|03|04|05|06|07|08\n'
    assert client.get(f'/api/shm/jobs/{result["job_id"]}/predictions.csv').status_code == 404
    assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths] == before


def test_acv_cleans_times_and_reports_insufficient_optional_telemetry(client, acv_frame):
    acv_frame['Car 08 - Indoor Temperature'] = 0
    acv_frame = acv_frame.drop(columns=[c for c in acv_frame if c.endswith('Setting Mode')])
    raw = acv_frame.to_csv(index=False).encode()
    duplicate = raw.splitlines()[1]
    invalid = b'invalid,' + duplicate.split(b',', 1)[1]
    raw += duplicate + b'\n' + invalid + b'\n' + b',' * (len(acv_frame.columns)-1) + b'\n'
    result = analyse(client, 'acv', raw)
    assert result['summary']['rows'] == 243
    evidence = result['evidence']
    assert evidence['analysed_rows'] == 241
    assert evidence['dropped_timestamp_rows'] == evidence['duplicate_timestamp_rows'] == 1
    assert result['prediction'][-1] == '08'
    assert evidence['cars'][-1]['has_data'] is False
    assert evidence['cars'][-1]['thermal_deficit_degC'] is None
    assert all(car['intervention_minutes'] is None for car in evidence['cars'])
    assert any('Timestamp cleanup' in warning for warning in result['warnings'])
    assert any('ranked last' in warning for warning in result['warnings'])


def test_acv_reports_script_cooling_filter_fallback(client, acv_frame):
    for column in acv_frame:
        if column.endswith('ACV Running Mode'):
            acv_frame[column] = 'Ventilation'
    result = analyse(client, 'acv', acv_frame.to_csv(index=False).encode())
    assert any('without cooling-mode and demand filters' in warning for warning in result['warnings'])


@pytest.mark.parametrize('change,detail', [
    ('short', 'usable thermal minutes'), ('cars', 'eight distinct two-digit car IDs'),
    ('timestamps', 'distinct valid timestamps'), ('columns', 'set-point columns'),
])
def test_acv_rejects_unusable_recordings_without_inventing_ranking(client, acv_frame, change, detail):
    if change == 'short':
        acv_frame = acv_frame.iloc[:3]
    elif change == 'cars':
        acv_frame = acv_frame.drop(columns=[c for c in acv_frame if c.startswith('Car 08')])
    elif change == 'timestamps':
        acv_frame['Time'] = 'invalid'
    else:
        acv_frame = acv_frame.drop(columns=[c for c in acv_frame if 'Control Temperature' in c])
    response = client.post('/api/acv/predict', files={'file': ('case.csv', acv_frame.to_csv(index=False).encode(), 'text/csv')})
    assert response.status_code == 422, response.text
    assert detail in response.json()['detail']
    assert not api.recording_jobs


def test_acv_invalid_workbook_and_prediction_table_are_actionable(client):
    for name, raw in [('bad.xlsx', b'not a workbook'), ('predictions.csv', b'file_id,ranked_cars\ncase.xlsx,01|02\n')]:
        response = client.post('/api/acv/predict', files={'file': (name, raw, 'application/octet-stream')})
        assert response.status_code == 422, response.text
        assert not api.recording_jobs


def test_acv_preserves_source_car_ids_without_renumbering(client, acv_frame):
    acv_frame = acv_frame.rename(columns=lambda name: name.replace('Car 0', 'Car 1'))
    result = analyse(client, 'acv', acv_frame.to_csv(index=False).encode())
    assert result['prediction'] == [str(i) for i in range(11, 19)]
    assert [car['car_id'] for car in result['evidence']['cars']] == result['prediction']
    assert client.get(result['downloads']['csv']).content == b'file_id,ranked_cars\nsample.csv,11|12|13|14|15|16|17|18\n'
