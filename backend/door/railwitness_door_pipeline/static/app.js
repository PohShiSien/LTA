'use strict';
const $=id=>document.getElementById(id);
let result=null, detail=null, activeIndex=null, detailRequest=0, busy=false;
const fmt=(v,n=2)=>Number(v).toFixed(n);
function text(id,value){$(id).textContent=value;}
function showError(message){text('error',message);$('error').hidden=false;}
async function fetchJSON(url,options){
  const r=await fetch(url,options);let data;
  try{data=await r.json();}catch{throw new Error('The server did not return a valid response. Check the Python terminal.');}
  if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail||data));
  return data;
}
async function analyse(file){
  if(!file||busy)return;
  busy=true;$('choose').disabled=true;$('error').hidden=true;$('results').hidden=true;
  $('progress').hidden=false;text('progress','Reading telemetry → finding cycles → classifying movements…');text('filename',file.name);
  const form=new FormData();form.append('file',file);
  try{
    result=await fetchJSON('/api/door/predict',{method:'POST',body:form});
    text('source',result.source_name);text('count',result.summary.cycles);text('normal',result.summary.normal);
    text('abnormal',result.summary.abnormal_resistance);text('rows',result.summary.rows.toLocaleString());
    text('runtime',fmt(result.summary.inference_seconds,3)+' s model inference');
    $('download-csv').href=result.downloads.csv;$('download-zip').href=result.downloads.zip;
    $('abnormal-only').checked=false;$('results').hidden=false;
    $('global-warnings').replaceChildren(...result.warnings.map(w=>{const p=document.createElement('p');p.textContent=w;return p;}));
    const first=result.segments.find(s=>s.prediction==='Abnormal resistance')||result.segments[0];
    activeIndex=first.cycle_index;renderList();await selectCycle(activeIndex);
    text('progress','Analysis complete. Select any movement to review its signals. Downloads use these exact predictions.');
  }catch(e){showError(e.message);$('progress').hidden=true;}
  finally{busy=false;$('choose').disabled=false;}
}
function renderList(){
  if(!result)return;
  const only=$('abnormal-only').checked;const visible=result.segments.filter(s=>!only||s.prediction==='Abnormal resistance');
  $('cycle-list').replaceChildren();
  for(const s of visible){
    const button=document.createElement('button');button.className='cycle-button'+(s.cycle_index===activeIndex?' selected':'');
    button.type='button';button.setAttribute('aria-pressed',String(s.cycle_index===activeIndex));
    const row=document.createElement('span');row.className='row';
    const title=document.createElement('span');title.textContent='Cycle '+String(s.cycle_index+1).padStart(3,'0');
    const duration=document.createElement('span');duration.textContent=fmt(s.duration_s)+' s';row.append(title,duration);
    const sub=document.createElement('span');sub.className='sub';sub.textContent=s.operation_inferred+' · '+s.n_rows+' readings';
    const state=document.createElement('span');state.className='cycle-status '+(s.prediction==='Normal'?'good':'warn');state.textContent=s.prediction;
    button.append(row,sub,state);button.addEventListener('click',()=>selectCycle(s.cycle_index));$('cycle-list').append(button);
  }
  if(!visible.length){const p=document.createElement('p');p.className='empty';p.textContent='No abnormal cycles.';$('cycle-list').append(p);}
}
async function selectCycle(index){
  const thisRequest=++detailRequest;activeIndex=index;renderList();
  try{
    const data=await fetchJSON(`/api/door/jobs/${result.job_id}/cycles/${index}`);
    if(thisRequest!==detailRequest)return;detail=data;
    const s=data.segment;text('cycle-meta',`CYCLE ${String(index+1).padStart(3,'0')} / RECORDED MOVEMENT`);
    text('cycle-title',s.operation_inferred+' movement');text('cycle-badge',s.prediction);
    $('cycle-badge').className='badge'+(s.prediction==='Normal'?'':' abnormal');
    text('direction',s.n_rows+' samples · '+fmt(s.duration_s)+' s');text('recommendation',s.recommendation);
    text('model-score',fmt(s.abnormal_model_score,3));
    $('cycle-stats').replaceChildren();
    for(const [label,value] of [['PEAK CURRENT',fmt(s.peak_current_A,3)+' A'],['START / SOURCE CLOCK',s.start_time],['END / SOURCE CLOCK',s.end_time]]){
      const box=document.createElement('div');const a=document.createElement('span');a.textContent=label;
      const b=document.createElement('strong');b.textContent=value;box.append(a,b);$('cycle-stats').append(box);
    }
    $('contributions').replaceChildren();
    for(const e of data.explanations.slice(0,5)){
      const row=document.createElement('div');row.className='contribution';
      const name=document.createElement('span');name.className='name';name.textContent=e.feature.replaceAll('_',' ');
      const val=document.createElement('span');val.className='number '+(e.log_odds_contribution>0?'warn':'good');
      val.textContent=(e.log_odds_contribution>=0?'+':'')+fmt(e.log_odds_contribution,3);val.title=e.direction;
      row.append(name,val);$('contributions').append(row);
    }
    $('cycle-warnings').replaceChildren(...s.data_quality_warnings.map(w=>{const p=document.createElement('p');p.className='warning-item';p.textContent=w;return p;}));
    drawChart();
  }catch(e){if(thisRequest===detailRequest)showError(e.message);}
}
const ns='http://www.w3.org/2000/svg';
function svgElement(name,attrs={}){const node=document.createElementNS(ns,name);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;}
function drawChart(){
  if(!detail)return;
  const key=$('signal').value;const ref=key==='current_A'?detail.reference:null;
  const labels={current_A:'MOTOR CURRENT / A',voltage_V:'MOTOR VOLTAGE / V',position_raw:'DOOR POSITION / RAW',bemf_raw:'BACK-EMF / RAW'};
  const w=760,h=305,left=60,right=18,top=29,bottom=49,pw=w-left-right,ph=h-top-bottom;
  const values=detail.points.map(p=>p[key]);if(ref)values.push(...ref.lower_A,...ref.upper_A);
  let low=Math.min(...values),high=Math.max(...values);const pad=Math.max((high-low)*.1,Math.abs(high)*.015,.005);
  low-=pad;high+=pad;
  const X=v=>left+v*pw,Y=v=>top+ph-(v-low)/(high-low)*ph;
  const svg=svgElement('svg',{viewBox:`0 0 ${w} ${h}`,role:'img','aria-label':labels[key]+' over normalised elapsed cycle time'});
  const addText=(x,y,str,extra={})=>{const t=svgElement('text',{x,y,fill:'#9bb0bc','font-size':10,'font-family':'ui-monospace,monospace',...extra});t.textContent=str;svg.append(t);};
  addText(left,15,labels[key],{'font-size':9});
  for(let i=0;i<=4;i++){
    const v=low+(high-low)*i/4,yy=Y(v);svg.append(svgElement('line',{x1:left,y1:yy,x2:w-right,y2:yy,stroke:'#23353f','stroke-width':1}));
    addText(left-10,yy+3,fmt(v,high-low>100?0:2),{'text-anchor':'end'});
  }
  for(let i=0;i<=5;i++){
    const xx=X(i/5);svg.append(svgElement('line',{x1:xx,y1:top,x2:xx,y2:top+ph,stroke:'#1b2b34','stroke-width':1}));
    addText(xx,h-bottom+20,(i*20)+'%',{'text-anchor':'middle'});
  }
  addText(left+pw/2,h-9,'NORMALISED ELAPSED CYCLE TIME',{'text-anchor':'middle','font-size':9});
  const path=(xs,ys)=>xs.map((x,i)=>(i?'L':'M')+X(x).toFixed(2)+','+Y(ys[i]).toFixed(2)).join(' ');
  if(ref){
    const upper=path(ref.elapsed_fraction,ref.upper_A);
    const reverse=ref.elapsed_fraction.slice().reverse().map((x,i)=>'L'+X(x).toFixed(2)+','+Y(ref.lower_A[ref.lower_A.length-1-i]).toFixed(2)).join(' ');
    svg.append(svgElement('path',{d:upper+' '+reverse+' Z',fill:'#466c79',opacity:.27}));
    svg.append(svgElement('path',{d:path(ref.elapsed_fraction,ref.median_A),fill:'none',stroke:'#9fb1ba','stroke-width':1.4,'stroke-dasharray':'5 5'}));
  }
  svg.append(svgElement('path',{d:path(detail.points.map(p=>p.elapsed_fraction),detail.points.map(p=>p[key])),fill:'none',stroke:'#63e6cb','stroke-width':2.4,'stroke-linejoin':'round'}));
  $('chart').replaceChildren(svg);$('reference-legend').hidden=!ref;
  text('reference-note',ref?`Reference: ${ref.n_normal_training_cycles} normal ${detail.segment.operation_inferred.toLowerCase()} training cycles. Descriptive percentiles, not a calibrated prediction interval or the classifier’s decision rule.`:detail.units[key==='position_raw'?'position':key==='bemf_raw'?'bemf':'voltage']);
}
$('choose').addEventListener('click',()=>$('file').click());$('file').addEventListener('change',e=>analyse(e.target.files[0]));
$('abnormal-only').addEventListener('change',renderList);$('signal').addEventListener('change',drawChart);
for(const name of ['dragenter','dragover'])$('dropzone').addEventListener(name,e=>{e.preventDefault();$('dropzone').classList.add('drag');});
for(const name of ['dragleave','drop'])$('dropzone').addEventListener(name,e=>{e.preventDefault();$('dropzone').classList.remove('drag');if(name==='drop')analyse(e.dataTransfer.files[0]);});
fetchJSON('/api/door/model').then(m=>text('model-info',`${m.model_name.replaceAll('_',' ')} · ${m.training_cycles} labelled training cycles · ${m.feature_count} features · Model ${m.model_id}`)).catch(e=>showError(e.message));
