"""Local model API. Run: python -B -m uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000."""
from __future__ import annotations
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Literal
import csv
import hashlib
import importlib
import io
import os
import sys
import tempfile
import time
import uuid
import zipfile
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from threadpoolctl import threadpool_limits
sys.dont_write_bytecode = True
from door.predict import DataError, Stream, Segment, load_stream, predictions_csv, load_bundle, predict_stream, cycle_detail

ROOT=Path(__file__).resolve().parent
# The app always loads the supplied deployment artifact. Validation models and
# environment-variable path overrides must never change production inference.
MODEL_PATH=ROOT/'door/door_model.joblib'
MAX_UPLOAD=25*1024*1024
MAX_JOBS=6
MAX_RECORDING_JOBS=200
JOB_TTL_SECONDS=3600

app=FastAPI(title='RailWitness Model API',version='1.0.0',description='Offline recording analysis. Read-only and advisory.')
origins=os.environ.get('RAILWITNESS_CORS_ORIGINS','http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000').split(',')
app.add_middleware(CORSMiddleware,allow_origins=[x.strip() for x in origins if x.strip()],
                   allow_credentials=False,allow_methods=['GET','POST'],allow_headers=['Content-Type'])

@dataclass
class Job:
    created: float
    stream: Stream
    segments: list[Segment]
    features: np.ndarray
    result: dict
    csv: bytes

jobs:dict[str,Job]={}
cache_lock=Lock()
# ponytail: one inference lock for this local app; use worker processes if concurrent throughput matters.
inference_lock=Lock()

@lru_cache(maxsize=1)
def model() -> dict:
    return load_bundle(MODEL_PATH)

def get_job(job_id: str) -> Job:
    with cache_lock:
        for key in list(jobs):
            if time.time()-jobs[key].created>JOB_TTL_SECONDS:del jobs[key]
        if job_id not in jobs:raise HTTPException(404,'Analysis expired or unknown. Re-analyse the recording, or upload the original CSV again.')
        return jobs[job_id]

@app.get('/',include_in_schema=False)
def index():
    return {'service':'RailWitness Model API','frontend':'http://127.0.0.1:5173','docs':'/docs'}

@app.get('/api/health')
def health():return {'status':'ok','mode':'local_advisory','model_file_present':MODEL_PATH.is_file()}

@app.get('/api/door/model')
def model_info():
    try:
        bundle=model()
    except (DataError,FileNotFoundError) as exc:raise HTTPException(503,str(exc)) from exc
    return {'model_name':bundle['model_name'],'model_id':bundle['model_id'],
            'training_cycles':bundle['training_cycles'],'versions':bundle['versions'],
            'segmenter':bundle['segmenter'],'feature_count':len(bundle['feature_names']),
            'reference_method':bundle['normal_reference']['method'],
            'score_description':'Uncalibrated classifier output; not failure probability.',
            'scope':'Supplied gap-separated Door recordings; no physical door identity or future-failure forecast.'}

@app.post('/api/door/predict')
def upload_predict(file:UploadFile=File(...)):
    filename=Path((file.filename or 'uploaded.csv').replace('\\','/')).name
    if not filename.lower().endswith('.csv'):
        raise HTTPException(422,'Upload a raw Door .csv file, not a ZIP, model, or example submission.')
    raw=file.file.read(MAX_UPLOAD+1)
    if len(raw)>MAX_UPLOAD:raise HTTPException(413,'File exceeds the 25 MiB limit.')
    try:
        bundle=model()
    except (DataError,FileNotFoundError) as exc:
        raise HTTPException(503,str(exc)) from exc
    try:
        stream=load_stream(raw);stream.source_name=filename
        with inference_lock,threadpool_limits(limits=1):
            result,segs,X=predict_stream(bundle,stream)
    except (DataError,FileNotFoundError) as exc:raise HTTPException(422,str(exc)) from exc
    result['source_sha256']=hashlib.sha256(raw).hexdigest()
    job_id=uuid.uuid4().hex
    base=f'/api/door/jobs/{job_id}'
    result.update({'job_id':job_id,'downloads':{'csv':base+'/predictions.csv','zip':base+'/predictions.zip'},
                   'retention':'Analysis cached in local memory for up to one hour or until eviction. Upload handling may use temporary local files; the app does not intentionally persist datasets.'})
    blob=predictions_csv(result['segments']).encode('utf-8')
    with cache_lock:
        for key in list(jobs):
            if time.time()-jobs[key].created>JOB_TTL_SECONDS:del jobs[key]
        while len(jobs)>=MAX_JOBS:
            del jobs[min(jobs,key=lambda key:jobs[key].created)]
        jobs[job_id]=Job(time.time(),stream,segs,X,result,blob)
    return result

@app.get('/api/door/jobs/{job_id}/cycles/{cycle_index}')
def detail(job_id:str,cycle_index:int):
    job=get_job(job_id)
    if not 0<=cycle_index<len(job.segments):raise HTTPException(404,'Cycle index is out of range.')
    with inference_lock,threadpool_limits(limits=1):
        evidence=cycle_detail(model(),job.stream,job.segments[cycle_index],job.features[cycle_index])
    return {'segment':job.result['segments'][cycle_index],**evidence}

@app.get('/api/door/jobs/{job_id}/predictions.csv')
def download_csv(job_id:str):
    return Response(get_job(job_id).csv,media_type='text/csv',
        headers={'Content-Disposition':'attachment; filename="door_predictions.csv"','Cache-Control':'no-store'})

@app.get('/api/door/jobs/{job_id}/predictions.zip')
def download_zip(job_id:str):
    memory=io.BytesIO()
    with zipfile.ZipFile(memory,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('door_predictions.csv',get_job(job_id).csv)
    return Response(memory.getvalue(),media_type='application/zip',
        headers={'Content-Disposition':'attachment; filename="predictions.zip"','Cache-Control':'no-store'})


# These jobs retain a single prediction per recording, not the uploaded sensor arrays.
recording_jobs: dict[str, tuple[float, dict, bytes]] = {}
RecordingSubsystem = Literal['rail', 'shm', 'acv']


@lru_cache(maxsize=3)
def recording_model(subsystem: RecordingSubsystem):
    folder, script = ('rail_corrugation', 'Predict') if subsystem == 'rail' else (subsystem, 'predict')
    path = ROOT / folder / f'{subsystem}_model.joblib'
    try:
        module = importlib.import_module(f'{folder}.{script}')
        if subsystem == 'rail':
            bundle = module.load(path)
            if (set(bundle['class_order']) != module.VALID_LABELS
                    or len(bundle['class_order']) != 3
                    or bundle['model'].n_features_in_ != len(bundle['feature_cols'])
                    or not hasattr(bundle['model'], 'predict_proba')):
                raise ValueError('Unsupported Rail model schema.')
            bundle['baseline']  # Required saved preprocessing, never fitted from uploads.
        elif subsystem == 'shm':
            bundle = module.load_bundle(path)
            linear = bundle['linear_model']
            for key in ('mean', 'scale', 'coefficients'):
                if len(linear[key]) != len(module.FEATURE_NAMES) or not np.isfinite(linear[key]).all():
                    raise ValueError('Unsupported SHM feature schema.')
            if not np.isfinite(linear['intercept']) or not all(x > 0 for x in linear['scale']):
                raise ValueError('Invalid SHM model scale.')
            for key in ('samples_per_file', 'range_moment_5_min', 'range_moment_5_max'):
                bundle['training'][key]
        else:
            bundle = module.load_bundle(path)
        model_id = hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception as exc:
        raise HTTPException(503, f'{subsystem.upper()} model unavailable: {exc}. Restore the supplied model/script and install backend/requirements.txt.') from exc
    return module, bundle, model_id


def recording_csv(results: list[dict]) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator='\n')
    is_acv = results[0]['subsystem'] == 'acv'
    writer.writerow(['file_id', 'ranked_cars' if is_acv else 'prediction'])
    for result in results:
        writer.writerow([result['source_name'], '|'.join(result['prediction']) if is_acv else result['prediction']])
    return out.getvalue().encode('utf-8')


def expire_recordings():
    # Caller holds cache_lock.
    for key in list(recording_jobs):
        if time.time() - recording_jobs[key][0] > JOB_TTL_SECONDS:
            del recording_jobs[key]


def get_recordings(subsystem: RecordingSubsystem, job_ids: list[str]) -> list[tuple[float, dict, bytes]]:
    with cache_lock:
        expire_recordings()
        results = []
        for job_id in job_ids:
            job = recording_jobs.get(job_id)
            if job is None or job[1]['subsystem'] != subsystem:
                raise HTTPException(404, 'Analysis expired, unknown, or belongs to another subsystem. Re-analyse the recording.')
            results.append(job)
        return results


def recording_download(subsystem: RecordingSubsystem, blob: bytes, format: Literal['csv', 'zip']):
    filename = f'{subsystem}_predictions.csv'
    if format == 'zip':
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(filename, blob)
        blob = memory.getvalue()
        filename = f'{subsystem}_predictions.zip'
    return Response(blob, media_type='text/csv' if format == 'csv' else 'application/zip',
                    headers={'Content-Disposition': f'attachment; filename="{filename}"', 'Cache-Control': 'no-store'})


@app.post('/api/{subsystem}/predict')
def upload_recording(subsystem: RecordingSubsystem, file: UploadFile = File(...)):
    filename = Path((file.filename or 'uploaded.csv').replace('\\', '/')).name
    extensions = ('.csv', '.xlsx') if subsystem == 'acv' else ('.csv',)
    if not filename.lower().endswith(extensions):
        raise HTTPException(422, f'Upload a raw {subsystem.upper()} {" or ".join(extensions)} recording, not a model, ZIP, or prediction table.')
    raw = file.file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, 'File exceeds the 25 MiB limit.')
    with inference_lock, threadpool_limits(limits=1):
        module, bundle, model_id = recording_model(subsystem)
        try:
            with np.errstate(over='raise', invalid='raise', divide='raise'):
                if subsystem == 'rail':
                    frame = module.load_recording(raw)
                    speed = float(module.speed_kmh(frame.iloc[:, 0].values))
                    sensor = module.per_sensor_table(frame)
                    sensor.insert(0, 'file_id', filename)
                    sensor.insert(1, 'speed_kmh', speed)
                    predicted = module.predict_sensor_table(sensor, bundle).iloc[0]
                    prediction = str(predicted['prediction'])
                    evidence = {'speed_kmh': speed, 'probabilities': {label: float(predicted[f'p_{label}']) for label in module.CLASS_ORDER}}
                    warnings = []
                    if len(frame) != 10000:
                        warnings.append(f'Recording has {len(frame)} samples; the supplied Rail test recordings contain 10000 samples.')
                    if speed < module.MOVING_KMH:
                        warnings.append('Estimated speed is below 5 km/h; the speed correction uses its 5 km/h lower bound.')
                    rows = len(frame)
                elif subsystem == 'shm':
                    values, warnings = module.load_series(raw)
                    predicted = module.predict_values(bundle, values, warnings)
                    prediction = float(predicted['prediction'])
                    if not np.isfinite(prediction) or prediction <= 0:
                        raise ValueError('SHM model returned a non-positive or non-finite damage estimate.')
                    evidence = {key: predicted[key] for key in ('cycles', 'residual_reversals', 'range_moment_5', 'class_width')}
                    warnings = predicted['warnings']
                    rows = len(values)
                else:
                    metadata = {}
                    # The supplied workbook reader needs a path; close and remove it after inference.
                    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix) as source:
                        source.write(raw)
                        source.flush()
                        prediction, scored = module.predict_file(source.name, bundle, metadata=metadata)
                    if len(prediction) != 8 or len(set(prediction)) != 8 or set(prediction) != set(scored.index):
                        raise ValueError('ACV model returned an invalid car ranking.')
                    cars = []
                    for car_id in prediction:
                        car = scored.loc[car_id]
                        optional_number = lambda key: None if np.isnan(car[key]) else float(car[key])
                        cars.append({'car_id': car_id, 'rank': int(car['rank']), 'probability': float(car['probability']),
                                     'thermal_deficit_degC': optional_number('TD'), 'valid_minutes': float(car['valid_minutes']),
                                     'has_data': bool(car['has_data']), 'intervention_minutes': optional_number('I_minutes'),
                                     'intervention_level': str(car['I_level']), 'compressor_start_ratio': optional_number('start_ratio')})
                    evidence = {'cars': cars, **{key: metadata[key] for key in ('analysed_rows', 'dropped_timestamp_rows', 'duplicate_timestamp_rows')}}
                    rows = metadata['rows']
                    warnings = ['This model assumes exactly one refrigerant leak per case. Its scores rank cars relative to this recording; they do not establish whether a leak is present.']
                    if metadata.get('relaxed_cooling_filter'):
                        warnings.append('Too few cars had sufficient cooling-mode data. The supplied script used its fallback without cooling-mode and demand filters.')
                    missing = [car['car_id'] for car in cars if not car['has_data']]
                    if missing:
                        warnings.append(f'Cars {", ".join(missing)} lack sufficient usable thermal data and are ranked last; this does not indicate healthy equipment.')
                    if metadata['dropped_timestamp_rows'] or metadata['duplicate_timestamp_rows']:
                        warnings.append(f'Timestamp cleanup excluded {metadata["dropped_timestamp_rows"]} invalid rows and {metadata["duplicate_timestamp_rows"]} duplicate rows. Evidence uses {metadata["analysed_rows"]} rows.')
        except (ValueError, UnicodeError, FloatingPointError, OverflowError) as exc:
            raise HTTPException(422, f'{subsystem.upper()} recording could not be analysed: {exc}') from exc
        except (KeyError, TypeError, AttributeError) as exc:
            raise HTTPException(503, f'{subsystem.upper()} model and prediction script are incompatible. Restore the matching supplied files.') from exc
    job_id = uuid.uuid4().hex
    base = f'/api/{subsystem}/jobs/{job_id}'
    result = {'subsystem': subsystem, 'job_id': job_id, 'model_name': bundle.get('model_name', bundle.get('model', subsystem)) if subsystem == 'acv' else bundle.get('model_name', subsystem),
              'model_id': model_id, 'source_name': filename, 'source_sha256': hashlib.sha256(raw).hexdigest(),
              'summary': {'rows': rows}, 'prediction': prediction, 'warnings': warnings, 'evidence': evidence,
              'downloads': {'csv': base + '/predictions.csv', 'zip': base + '/predictions.zip'}}
    blob = recording_csv([result])
    with cache_lock:
        expire_recordings()
        while len(recording_jobs) >= MAX_RECORDING_JOBS:
            del recording_jobs[min(recording_jobs, key=lambda key: recording_jobs[key][0])]
        recording_jobs[job_id] = (time.time(), result, blob)
    return result


@app.get('/api/{subsystem}/jobs/{job_id}/predictions.{format}')
def download_recording(subsystem: RecordingSubsystem, job_id: str, format: Literal['csv', 'zip']):
    return recording_download(subsystem, get_recordings(subsystem, [job_id])[0][2], format)


class RecordingExport(BaseModel):
    job_ids: list[str] = Field(min_length=1, max_length=MAX_RECORDING_JOBS)
    format: Literal['csv', 'zip']


@app.post('/api/{subsystem}/export')
def export_recordings(subsystem: RecordingSubsystem, request: RecordingExport):
    results = [job[1] for job in get_recordings(subsystem, request.job_ids)]
    names = [result['source_name'] for result in results]
    if len(set(names)) != len(names):
        raise HTTPException(422, 'Export contains duplicate file_id values. Keep one analysis per file name or rename the source files and re-analyse.')
    return recording_download(subsystem, recording_csv(results), request.format)
