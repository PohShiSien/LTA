"""Integration safeguards around the supplied frozen inference pipeline."""
import hashlib
import io
import os
from pathlib import Path
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app as api
from door.predict import COLUMNS, DataError, load_stream


@pytest.fixture(autouse=True)
def isolated_job_cache():
    api.jobs.clear()
    yield
    api.jobs.clear()


def analyse(client, blob, filename='sample.csv'):
    response = client.post('/api/door/predict', files={'file': (filename, blob, 'text/csv')})
    assert response.status_code == 200, response.text
    return response.json()


def test_deployment_artifact_is_frozen_and_path_cannot_be_overridden(monkeypatch):
    monkeypatch.setenv('RAILWITNESS_MODEL', str(api.ROOT / 'door/validation_model.joblib'))
    assert api.MODEL_PATH == api.ROOT / 'door/door_model.joblib'
    assert hashlib.sha256(api.MODEL_PATH.read_bytes()).hexdigest() == (
        '077e4a21838857e4b6bb2e5d2c9b9e1c7741a84d00c52a2d41ecb2489750ea7c'
    )
    assert api.model()['model_name'] == 'logistic_regression'
    assert api.model()['model_id'] == '7a34ab10e5140f7e'


def test_indices_cover_every_source_row_once(synthetic_csv):
    stream = load_stream(synthetic_csv)
    coverage = np.zeros(len(stream.timestamps), dtype=int)
    with TestClient(api.app) as client:
        result = analyse(client, synthetic_csv)
        for index, segment in enumerate(result['segments']):
            assert segment['cycle_index'] == index
            lo, hi = segment['start_index'], segment['end_index'] + 1
            assert hi - lo == segment['n_rows']
            assert segment['start_time'] == stream.timestamps[lo]
            assert segment['end_time'] == stream.timestamps[hi - 1]
            assert segment['asset_id'] is None
            coverage[lo:hi] += 1
        assert np.all(coverage == 1)
        assert result['summary']['rows'] == len(coverage)
        assert result['summary']['cycles'] == len(result['segments'])
        assert result['summary']['normal'] + result['summary']['abnormal_resistance'] == len(result['segments'])


def test_cycle_detail_retains_recorded_units_and_training_reference(synthetic_csv):
    stream = load_stream(synthetic_csv)
    with TestClient(api.app) as client:
        result = analyse(client, synthetic_csv)
        for segment in result['segments']:
            detail = client.get(f'/api/door/jobs/{result["job_id"]}/cycles/{segment["cycle_index"]}').json()
            points = detail['points']
            lo, hi = segment['start_index'], segment['end_index'] + 1
            np.testing.assert_allclose([p['current_A'] for p in points], stream.x[lo:hi,COLUMNS.index('current')] / 1000)
            np.testing.assert_allclose([p['voltage_V'] for p in points], stream.x[lo:hi,COLUMNS.index('voltage')] * .01)
            np.testing.assert_allclose([p['position_raw'] for p in points], stream.x[lo:hi,COLUMNS.index('position')])
            assert points[0]['elapsed_fraction'] == 0
            assert points[-1]['elapsed_fraction'] == 1
            reference = detail['reference']
            assert reference == api.model()['normal_reference']['by_operation'][segment['operation_inferred']]
            assert len(reference['lower_A']) == len(reference['median_A']) == len(reference['upper_A'])
            assert 'not a calibrated prediction interval' in detail['reference_limitation']
            assert detail['explanations']
            for explanation in detail['explanations']:
                expected = 'toward Abnormal resistance' if explanation['log_odds_contribution'] > 0 else 'toward Normal'
                assert explanation['direction'] == expected


@pytest.mark.parametrize('endpoint', ['cycles/0', 'predictions.csv', 'predictions.zip'])
def test_expired_jobs_give_reanalyse_instruction(endpoint, synthetic_csv, monkeypatch):
    with TestClient(api.app) as client:
        result = analyse(client, synthetic_csv)
        job_id = result['job_id']
        expired_time = api.jobs[job_id].created + api.JOB_TTL_SECONDS + 1
        monkeypatch.setattr(api.time, 'time', lambda: expired_time)
        response = client.get(f'/api/door/jobs/{job_id}/{endpoint}')
        assert response.status_code == 404
        assert 'Re-analyse' in response.json()['detail']
        assert job_id not in api.jobs


def test_job_eviction_keeps_latest_recording(synthetic_csv, monkeypatch):
    monkeypatch.setattr(api, 'MAX_JOBS', 1)
    with TestClient(api.app) as client:
        first = analyse(client, synthetic_csv)
        latest = analyse(client, synthetic_csv)
        assert client.get(first['downloads']['csv']).status_code == 404
        assert client.get(latest['downloads']['csv']).status_code == 200
        assert len(api.jobs) == 1


def test_model_failure_has_no_predictions_or_job(synthetic_csv, monkeypatch):
    def unavailable():
        raise DataError('Restore the supplied deployment artifact.')
    monkeypatch.setattr(api, 'model', unavailable)
    with TestClient(api.app) as client:
        response = client.post('/api/door/predict', files={'file': ('sample.csv', synthetic_csv, 'text/csv')})
        assert response.status_code == 503
        assert 'segments' not in response.json()
        assert not api.jobs


def test_upload_limit_rejects_before_inference(monkeypatch):
    monkeypatch.setattr(api, 'MAX_UPLOAD', 16)
    with TestClient(api.app) as client:
        response = client.post('/api/door/predict', files={'file': ('sample.csv', b'x' * 17, 'text/csv')})
        assert response.status_code == 413
        assert not api.jobs


def test_local_frontend_cors():
    with TestClient(api.app) as client:
        response = client.options('/api/door/predict', headers={
            'Origin': 'http://127.0.0.1:5173',
            'Access-Control-Request-Method': 'POST',
        })
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == 'http://127.0.0.1:5173'


@pytest.mark.skipif(not os.environ.get('DOOR_ACCEPTANCE_CSV'), reason='Set DOOR_ACCEPTANCE_CSV to the external supplied test recording.')
def test_supplied_recording_acceptance():
    """Expected frozen-model predictions, explicitly not test ground truth."""
    source = Path(os.environ['DOOR_ACCEPTANCE_CSV'])
    raw = source.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == '8cbea142cf46eac40455ddcac17e334c1842a6f7632f006e48c7d0d41582bfe3'
    with TestClient(api.app) as client:
        result = analyse(client, raw, source.name)
        summary = result['summary']
        assert summary['rows'] == 6253
        assert summary['cycles'] == 38
        assert summary['normal'] == 30
        assert summary['abnormal_resistance'] == 8
        coverage = np.zeros(summary['rows'], dtype=int)
        for segment in result['segments']:
            coverage[segment['start_index']:segment['end_index'] + 1] += 1
        assert np.all(coverage == 1)
        csv_bytes = client.get(result['downloads']['csv']).content
        assert hashlib.sha256(csv_bytes).hexdigest() == '2f94f8f5e2ccd6bce223a7c2f9fd2c7b974aa17cbce3d7bc3521dd100d7a079b'
        with zipfile.ZipFile(io.BytesIO(client.get(result['downloads']['zip']).content)) as archive:
            assert archive.namelist() == ['door_predictions.csv']
            assert archive.read('door_predictions.csv') == csv_bytes
