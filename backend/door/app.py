"""Local upload/inference/evidence/download app. Run: python -m uvicorn app:app --host 127.0.0.1 --port 8000."""
from __future__ import annotations
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import Lock
import hashlib
import io
import os
import time
import uuid
import zipfile
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from threadpoolctl import threadpool_limits
from door_pipeline.io import DataError, Stream, Segment, load_stream, predictions_csv
from door_pipeline.runtime import load_bundle, predict_stream, cycle_detail

ROOT=Path(__file__).resolve().parent
# The app always loads the supplied deployment artifact. Validation models and
# environment-variable path overrides must never change production inference.
MODEL_PATH=ROOT/'models/door_model.joblib'
MAX_UPLOAD=25*1024*1024
MAX_JOBS=6
JOB_TTL_SECONDS=3600

app=FastAPI(title='RailWitness Door API',version='1.0.0',description='Offline completed-cycle analysis. Read-only and advisory.')
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
# Keep prediction jobs serial in this small local app; avoid concurrent threadpool reconfiguration.
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
    return {'service':'RailWitness Door API','frontend':'http://127.0.0.1:5173','docs':'/docs'}

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
