import csv
from dataclasses import replace
from datetime import datetime, timedelta
import io
from pathlib import Path
from shutil import copyfile
import subprocess
import sys
import zipfile
import numpy as np
import pytest
from fastapi.testclient import TestClient
from door.predict import (COLUMNS, DataError, GapSegmenter, cycle_detail, cycle_signals,
                         feature_matrix, load_bundle, load_stream, make_segment,
                         parse_timestamp, predict_stream, predictions_csv)
from app import app

ROOT=Path(__file__).resolve().parents[2]/'backend'

def change_csv(blob,transform):
    rows=list(csv.reader(io.StringIO(blob.decode())));transform(rows)
    s=io.StringIO();csv.writer(s).writerows(rows);return s.getvalue().encode()

def test_native_millisecond_not_fraction():
    assert parse_timestamp('2023-7-5-0-0-0-92')-parse_timestamp('2023-7-5-0-0-0-0')==92

def test_native_iso_equivalence():
    assert parse_timestamp('2023-7-5-0-0-3-760')==parse_timestamp('2023-07-05T00:00:03.760')

@pytest.mark.parametrize('stamp',['2023-13-1-0-0-0-0','wrong','2023-07-05T00:00:00.000001','2023-07-05T00:00:00+08:00'])
def test_invalid_timestamp(stamp):
    with pytest.raises(DataError):parse_timestamp(stamp)

def test_reordered_columns(synthetic_csv):
    blob=change_csv(synthetic_csv,lambda rows:[r.reverse() for r in rows])
    assert np.array_equal(load_stream(blob).x,load_stream(synthetic_csv).x)

def test_reject_submission_not_stream():
    with pytest.raises(DataError,match='raw Door stream'):
        load_stream(b'start_time,end_time,prediction\na,b,Normal\n')

def test_reject_duplicate_timestamps(synthetic_csv):
    blob=change_csv(synthetic_csv,lambda rows:rows[2].__setitem__(0,rows[1][0]))
    with pytest.raises(DataError,match='strictly increase'):load_stream(blob)

def test_reject_wrong_column_count(synthetic_csv):
    blob=change_csv(synthetic_csv,lambda rows:rows[3].pop())
    with pytest.raises(DataError,match='expected 17 fields'):load_stream(blob)

def test_reject_duplicate_header(synthetic_csv):
    blob=change_csv(synthetic_csv,lambda rows:rows[0].__setitem__(2,rows[0][1]))
    with pytest.raises(DataError,match='Duplicate column'):load_stream(blob)

def test_reject_infinite(synthetic_csv):
    blob=change_csv(synthetic_csv,lambda rows:rows[2].__setitem__(1,'inf'))
    with pytest.raises(DataError,match='infinite'):load_stream(blob)

def test_units_and_direction(synthetic_csv):
    s=load_stream(synthetic_csv);a=cycle_signals(s,make_segment(s,0,151))
    assert a['operation']=='Open';assert a['voltage'][0]==15
    assert a['current'][0]==pytest.approx(.4)
    assert cycle_signals(s,make_segment(s,151,302))['operation']=='Close'

def test_segmenter_uses_frozen_parameters(synthetic_csv):
    s=load_stream(synthetic_csv);truth=[make_segment(s,0,151),make_segment(s,151,302)]
    parameters=load_bundle(ROOT/'door/door_model.joblib')['segmenter']
    segmenter=GapSegmenter(**parameters);pred=segmenter.predict(s)
    assert pred==truth
    assert 20<segmenter.threshold_ms<17000
    assert segmenter.threshold_ms==parameters['threshold_ms']

def test_segmenter_not_flag_edges(synthetic_csv):
    s=load_stream(synthetic_csv);s.x[30:60,COLUMNS.index('is_opening')]=0
    pred=GapSegmenter(threshold_ms=200).predict(s)
    assert len(pred)==2

def test_singleton_not_silently_dropped(synthetic_csv):
    # Use a proper increasing stream with an isolated first sample.
    original=load_stream(synthetic_csv)
    s=replace(original,timestamps=original.timestamps[150:302],t_ms=original.t_ms[150:302],x=original.x[150:302])
    with pytest.raises(DataError):GapSegmenter(threshold_ms=200).predict(s)

def test_current5_features_no_clock_or_ids(synthetic_csv):
    s=load_stream(synthetic_csv);segs=GapSegmenter(threshold_ms=200).predict(s)
    x,names=feature_matrix(s,segs)
    assert x.shape==(2,5)
    assert names==['moving_current_mean_A','moving_current_q90_A','moving_current_rms_A','current_q10_A','current_median_A']
    assert names==load_bundle(ROOT/'door/door_model.joblib')['feature_names']
    assert not any(n in names for n in ['timestamp','segment_id','status','operation_label','opening_time','closing_time'])
    assert np.all(np.isfinite(x))

def test_features_invariant_to_absolute_clock(synthetic_csv):
    s=load_stream(synthetic_csv);segs=GapSegmenter(threshold_ms=200).predict(s)
    a,_=feature_matrix(s,segs)
    s.t_ms=s.t_ms+1234567
    s.timestamps=[(datetime(1970,1,1)+timedelta(milliseconds=int(v))).isoformat(timespec='milliseconds') for v in s.t_ms]
    b,_=feature_matrix(s,GapSegmenter(threshold_ms=200).predict(s))
    np.testing.assert_allclose(a,b,equal_nan=True)

def test_low_missing_values_interpolated_with_warning(synthetic_csv):
    s=load_stream(synthetic_csv);s.x[50,COLUMNS.index('current')]=np.nan
    a=cycle_signals(s,make_segment(s,0,151));assert np.isfinite(a['current']).all();assert a['warnings']

def test_excess_cycle_missing_rejected(synthetic_csv):
    s=load_stream(synthetic_csv);s.x[10:40,COLUMNS.index('current')]=np.nan
    with pytest.raises(DataError):cycle_signals(s,make_segment(s,0,151))

def test_prediction_schema_only_three_columns():
    out=predictions_csv([{'start_time':'2023-7-5-0-0-0-0','end_time':'2023-7-5-0-0-1-0','prediction':'Normal','score':.6}])
    assert out.splitlines()[0]=='start_time,end_time,prediction'

def test_trained_artifact_and_repeatability(synthetic_csv):
    b=load_bundle(ROOT/'door/door_model.joblib');s=load_stream(synthetic_csv)
    a,segs,x=predict_stream(b,s);c,_,_=predict_stream(b,s)
    assert a['segments']==c['segments'];assert len(segs)==2
    d=cycle_detail(b,s,segs[0],x[0]);assert d['reference'];assert d['explanations'];assert d['points']
    assert list(d['features'])==b['feature_names'];assert len(d['features'])==5
    assert a['segments'][0]['asset_id'] is None

def test_api_round_trip_and_download(synthetic_csv):
    with TestClient(app) as client:
        assert client.get('/').status_code==200
        assert client.get('/api/health').json()['status']=='ok'
        assert client.get('/api/door/model').json()['feature_count']==5
        r=client.post('/api/door/predict',files={'file':('sample.csv',synthetic_csv,'text/csv')})
        assert r.status_code==200,r.text
        result=r.json();assert result['summary']['cycles']==2
        content=client.get(result['downloads']['csv']).content
        assert content.decode()==predictions_csv(result['segments'])
        blob=client.get(result['downloads']['zip']).content
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            assert z.namelist()==['door_predictions.csv'];assert z.read('door_predictions.csv')==content
        d=client.get(f'/api/door/jobs/{result["job_id"]}/cycles/0');assert d.status_code==200
        assert client.get(f'/api/door/jobs/{result["job_id"]}/cycles/-1').status_code==404
        assert client.get('/api/door/jobs/unknown/predictions.csv').status_code==404

@pytest.mark.parametrize('name,blob',[('model.joblib',b'bad'),('sample.csv',b'start_time,end_time,prediction\na,b,Normal\n'),('empty.csv',b'')])
def test_api_bad_input_returns_actionable_error(name,blob):
    with TestClient(app) as client:
        r=client.post('/api/door/predict',files={'file':(name,blob,'text/csv')})
        assert r.status_code==422;assert r.json()['detail']

def test_cli_and_api_match(synthetic_csv,tmp_path):
    source=tmp_path/'sample.csv';source.write_bytes(synthetic_csv)
    out=tmp_path/'predictions.csv'
    p=subprocess.run([sys.executable,str(ROOT/'door/predict.py'),'--input',str(source),'--output',str(out)],capture_output=True,text=True,timeout=30)
    assert p.returncode==0,p.stderr
    with TestClient(app) as client:
        r=client.post('/api/door/predict',files={'file':('sample.csv',synthetic_csv,'text/csv')}).json()
        expected=client.get(r['downloads']['csv']).content
        assert out.read_bytes()==expected
    standalone=tmp_path/'standalone';standalone.mkdir()
    script=standalone/'predict.py';copyfile(ROOT/'door/predict.py',script)
    model=standalone/'door_model.joblib';copyfile(ROOT/'door/door_model.joblib',model)
    default=subprocess.run([sys.executable,str(script),'--input',str(source)],cwd=tmp_path,capture_output=True,text=True,timeout=30)
    assert default.returncode==0,default.stderr
    assert (standalone/'door_predictions.csv').read_bytes()==expected
    for protected in (source,model,script):
        before=protected.read_bytes()
        blocked=subprocess.run([sys.executable,str(script),'--input',str(source),'--output',str(protected)],capture_output=True,text=True,timeout=30)
        assert blocked.returncode!=0
        if protected.suffix=='.csv':
            assert 'must not overwrite' in blocked.stderr
        else:
            # Non-CSV --output arguments are directories in the supplied script.
            assert 'File exists' in blocked.stderr and str(protected) in blocked.stderr
        assert protected.read_bytes()==before
