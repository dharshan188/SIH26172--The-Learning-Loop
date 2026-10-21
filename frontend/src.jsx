import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Activity, AudioLines, BarChart3, Box, BrainCircuit, Check, CircleGauge, Clock, Cloud, Cpu, Database, FileText, Gauge, Home as HomeIcon, Info, Lightbulb, Mic, Play, Rocket, Scale, ShieldCheck, Target, Waves, Zap} from 'lucide-react';
import './style.css';
import isroLogo from './assets/isro-logo.svg';
import sihLogo from './assets/sih-logo-dark.png';
import homeArtwork from './assets/home-artwork.png';
import {modelMetrics, dashboardModelSummary, datasetMetrics} from './modelMetrics.js';
import {mountScene, setSceneEnergy} from './scene3d.js';
import {mountTilt, staggerReveal, countUp, mountHeroParallax, mountCursor} from './fx.js';

const backendHttp = (import.meta.env.VITE_BACKEND_URL || `${location.protocol}//${location.hostname || 'localhost'}:8011`).replace(/\/$/, '');
const number = (value, digits = 0, suffix = '') => Number.isFinite(value) ? `${value.toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits})}${suffix}` : '--';
const audioArray = value => Array.isArray(value) && value.length && value.every(Number.isFinite) ? value : null;
const melArray = value => Array.isArray(value) && value.length && value.every(row => audioArray(row)) ? value : null;
const finalModel = {
  name:'MARVIN S1+S2 Cascade', architecture:'Two-stage Temporal TinyML Cascade',
  heldOut:{accuracy:98.66,precision:95.97,recall:96.36,f1:96.16},
  thresholds:{s1:0.6,s2:0.65}, threshold:0.6, rawThreshold:0.65,
  parameters:dashboardModelSummary.parameters, parametersSource:dashboardModelSummary.reportSource, size:{modelBytes:28312,label:'27.65 KiB measured'},
  benchmark:{staticRam:'113.3 KiB',staticRamBytes:116060,hopMs:640,cpuDuty:'~7.5%',candidateDecision:'~51–52 ms',total:'~51–52 ms'},
  cooldownMs:1500,
};
const validationModels = modelMetrics.validation;
const percent = (value, digits = 2) => Number.isFinite(value) ? `${value.toFixed(digits)}%` : '--';
const corpus = datasetMetrics;
const pages = [{id:'home', name:'Home', icon:HomeIcon}, {id:'live-monitor', name:'Live Monitor', icon:AudioLines}, {id:'model-comparison', name:'Model Comparison', icon:BarChart3}, {id:'dataset', name:'Dataset', icon:Database}];

function useBackend() {
  const [data, setData] = useState({}), [online, setOnline] = useState(false), socket = useRef(null);
  useEffect(() => {
    let timer, disposed = false;
    const connect = () => {
      const connection = new WebSocket(`${backendHttp.replace(/^http/, 'ws')}/ws/dashboard`);
      socket.current = connection;
      connection.onopen = () => {if (!disposed) setOnline(true);};
      connection.onmessage = event => {
        try {const payload = JSON.parse(event.data); if (!disposed && payload.type === 'snapshot') setData(payload);} catch {}
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {if (!disposed) {setOnline(false); setData({}); timer = setTimeout(connect, 1500);}};
    };
    connect();
    return () => {disposed = true; clearTimeout(timer); socket.current?.close();};
  }, []);
  return {data, online, connected: online && data.esp32_connected === true, send: command => {if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({command}));}};
}

function Brand({small = false}) {return <div className={`brand ${small ? 'small' : ''}`}><span className="infinity">∞</span><div><strong>Learning Loop</strong><small>{small ? 'PSG Institute of Technology and Applied Research' : 'Listen · Learn · Loop · Build'}</small></div></div>;}
function Isro() {return <a className="isro" href="https://www.isro.gov.in/" target="_blank" rel="noreferrer" aria-label="Indian Space Research Organisation official website"><img src={isroLogo} alt="ISRO — Indian Space Research Organisation" width="108" height="104"/></a>;}
function Sih({className = ''}) {return <a className={`sih ${className}`} href="https://sih.gov.in/" target="_blank" rel="noreferrer" aria-label="Smart India Hackathon official website"><img src={sihLogo} alt="Smart India Hackathon 2026" width="181" height="92"/></a>;}
function WaveMark() {return <svg viewBox="0 0 108 110" fill="none" aria-hidden="true"><defs><linearGradient id="marvin-wave" x1="0" y1="0" x2="0" y2="110" gradientUnits="userSpaceOnUse"><stop stopColor="#4ff8ff"/><stop offset=".55" stopColor="#00e9ed"/><stop offset="1" stopColor="#0077ff"/></linearGradient></defs>{[8,34,58,92,58,34,8].map((height,index) => <path key={index} d={`M${6 + index * 16} ${55 - height / 2}v${height}`} stroke="url(#marvin-wave)" strokeWidth="9" strokeLinecap="round"/>)}</svg>;}
function Status({active, children}) {return <span className={`status ${active ? 'online' : ''}`}><i/>{children}</span>;}
function Panel({title, icon:Icon = Activity, children, className = '', aside}) {return <section className={`panel ${className}`}><div className="panel-title"><Icon/><h2>{title}</h2>{aside && <span className="panel-aside">{aside}</span>}</div>{children}</section>;}
function Rows({items}) {return <dl className="rows">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '--'}</dd></div>)}</dl>;}
function Orb({icon:Icon, color = ''}) {return <span className={`orb ${color}`}><Icon/></span>;}
function EmptyPlot({kind = 'wave', history = [], samples, matrix, label, compact = false}) {
  const valid = history.filter(item => Number.isFinite(item.s1) || Number.isFinite(item.s2)).slice(-50);
  const confidence = kind === 'confidence';
  const waveform = kind === 'wave' ? audioArray(samples) : null;
  const spectrogram = kind === 'mel' ? melArray(matrix) : null;
  const hasData = confidence ? valid.length > 0 : kind === 'wave' ? Boolean(waveform) : Boolean(spectrogram);
  const ticks = kind === 'mel' ? ['8 kHz','4 kHz','2 kHz','1 kHz','0 Hz'] : confidence ? ['1.0','0.5','0.0'] : ['1.0','0.5','0','-0.5','-1.0'];
  const points = key => {
    let drawing = false;
    return valid.map((item, index) => {
      if (!Number.isFinite(item[key])) {drawing = false; return '';}
      const command = drawing ? 'L' : 'M'; drawing = true;
      return `${command}${index * 1000 / Math.max(1, valid.length - 1)},${160 - Math.max(0, Math.min(1, item[key])) * 160}`;
    }).join(' ');
  };
  const timeTicks = confidence ? [0, .25, .5, .75, 1].map(fraction => number(valid.length > 1 ? (valid.at(-1).at - valid[0].at) * fraction : undefined,2,'s')) : ['0s','1s','2s','3s','4s','5s'];
  const wavePoints = waveform?.map((sample,index) => `${index * 1000 / Math.max(1,waveform.length - 1)},${80 - Math.max(-1,Math.min(1,sample)) * 80}`).join(' ');
  const melCells = spectrogram?.flatMap((frame,x) => frame.map((value,band) => <rect key={`${x}-${band}`} x={x * 1000 / spectrogram.length} y={(23 - band) * 160 / 24} width={1000 / spectrogram.length + .5} height={160 / 24 + .5} fill={`hsl(${220 - Math.max(0,Math.min(1,value)) * 175} 95% 50%)`}/>));
  return <div className={`plot-wrap ${compact ? 'compact' : ''} ${kind}`}><div className="axis-y">{ticks.map(tick => <span key={tick}>{tick}</span>)}</div><div className="plot"><svg viewBox="0 0 1000 160" preserveAspectRatio="none" aria-label={label || 'Audio data plot'}>{confidence && hasData && <><path d={points('s1')} className="cyan-line"/><path d={points('s2')} className="purple-line"/></>}{waveform && <polyline points={wavePoints} className="cyan-line"/>}{melCells}</svg>{!hasData && <div className="empty-plot"><strong>--</strong><span>{label || 'Waiting for audio data'}</span></div>}</div><div className="axis-x">{timeTicks.map((tick,index) => <span key={index}>{tick}</span>)}</div>{kind === 'mel' && <div className="color-scale"><i/><span>High<br/>Low</span></div>}</div>;
}
const comparisonModels = [
  {id:'final',short:'MARVIN (Ours)',name:'MARVIN',final:true,architecture:'Two-stage CNN + Temporal Verifier',quantization:'INT8',accuracy:'99.50% validation',ram:'~107 KB static RAM',cpu:'~7.39% measured',twoStep:'✓ Yes — Candidate + Verifier',latency:'~51–52 ms candidate decision'},
  {id:'dscnn',short:'DS-CNN',name:'MLPerf Tiny DS-CNN',reference:true,published:true,architecture:'DS-CNN',quantization:'Quantization supported',accuracy:'90% quality target',ram:'Hardware/implementation dependent',cpu:'Hardware dependent',twoStep:'✗ Single model',latency:'Hardware dependent'},
  {id:'wakenet9',short:'WakeNet9',name:'Espressif WakeNet9',reference:true,published:true,architecture:'Dilated CNN',quantization:'INT8 / Quantized',accuracy:'98% quiet-condition',ram:'16 KB RAM + 324 KB PSRAM**',cpu:'Not separately reported',twoStep:'✗ Not reported as a two-stage verifier',latency:'3.0 ms per 32-ms frame**'},
];
const comparisonCharts = [
  {title:'Accuracy',icon:Target,unit:'%',better:'Higher is better',max:100,digits:2,values:{final:99.5,dscnn:90,wakenet9:98}},
  {title:'Parameters',icon:BrainCircuit,unit:'',better:'Fewer is smaller',max:40000,digits:0,values:{final:20734,dscnn:38600}},
  {title:'Model Size',icon:Box,unit:' KiB',better:'Lower is better',max:60,digits:2,values:{final:27.65,dscnn:52.5/1.024}},
];
const comparisonFields = [['Architecture','architecture'],['Quantization','quantization'],['Accuracy','accuracy'],['RAM Usage','ram'],['CPU Usage','cpu'],['Two-Step Verification','twoStep'],['Latency','latency']];
function evidenceKind(model) {return model.reference ? 'published' : 'measured';}
function EvidenceBadge({kind}) {return kind && kind!=='published' ? <small className={`metric-badge ${kind}`}>{kind.toUpperCase()}</small> : null;}
function ComparisonCell({model,metric}) {
  const kind=evidenceKind(model,metric);
  if (metric==='status' && model.final) return <><span className="final-badge">DEPLOYED</span><span className="final-badge">OUR FINAL MODEL</span></>;
  return <><span className="comparison-cell-value">{model[metric]}</span><EvidenceBadge kind={kind}/>{model.reference && <small className="metric-badge published">PUBLISHED REFERENCE</small>}{metric==='size' && ['v1','v2'].includes(model.id) && <small className="comparison-cell-detail">Parameter weights only</small>}{metric==='threshold' && ['v1','v2'].includes(model.id) && <small className="comparison-cell-detail">Estimated operating threshold</small>}{metric==='ram' && !model.final && !model.reference && <small className="comparison-cell-detail">Standalone deployment estimate</small>}{metric==='latency' && model.id==='v5' && <small className="comparison-cell-detail">When Stage 2 is invoked</small>}{metric==='latency' && model.final && <small className="comparison-cell-detail">Candidate decision latency</small>}</>;
}
function BarChart({title,icon,unit,better,max,digits,values}) {
  const ticks=[0,.25,.5,.75,1];
  return <Panel title={title} icon={icon} className="bar-chart" aside={better}><div className="bar-chart-body"><div className="bar-grid" aria-hidden="true">{ticks.map(tick=><i key={tick} style={{left:`${tick*100}%`}}/>)}</div>{comparisonModels.map(model=>{const value=values[model.id],available=Number.isFinite(value),label=available?number(value,digits,unit):'Not reported';return <div className={`bar-row ${model.final?'final':''}`} key={model.id} title={`${model.name}: ${label}`}><span className="bar-name">{model.short}</span><div className="bar-track">{available ? <i className="bar-fill" style={{width:`${Math.max(1.5,Math.min(100,value/max*100))}%`}}/> : <em>Not reported</em>}</div><b className="bar-value">{available?label:'—'}</b></div>;})}<div className="bar-axis" aria-hidden="true">{ticks.map(tick=><span key={tick} style={{left:`${tick*100}%`}}>{number(max*tick,0,unit.trim()==='%'?'%':'')}</span>)}</div></div></Panel>;
}
function Speedometer({title,value,unit,caption,ratio,tone='heap',leftLabel,rightLabel,detail}) {
  const valid = Number.isFinite(value) && Number.isFinite(ratio);
  const bounded = valid ? Math.max(0,Math.min(1,ratio)) : 0;
  const angle = Math.PI * (1-bounded), tipX=100+72*Math.cos(angle), tipY=105-72*Math.sin(angle);
  const status = !valid ? 'unknown' : tone === 'cpu' ? value > 10 ? 'low' : 'high' : bounded < .25 ? 'low' : bounded < .5 ? 'medium' : 'high';
  return <div className={`speedometer ${status}`}><h3>{title}</h3><svg viewBox="0 0 200 130" role="img" aria-label={`${title}: ${valid ? number(value,2,unit) : 'not available'}`}><path className="speed-track" d="M20 105 A80 80 0 0 1 180 105"/><path className="speed-progress" d="M20 105 A80 80 0 0 1 180 105" strokeDasharray={`${bounded*251.33} 251.33`}/>{valid && <><line className="speed-needle" x1="100" y1="105" x2={tipX} y2={tipY}/><circle cx="100" cy="105" r="5" className="speed-pivot"/></>}</svg><div className="speed-readout"><strong>{valid ? number(value,2,unit) : '--'}</strong><span>{caption}</span></div><div className="speed-axis"><small>{leftLabel}</small><small>{rightLabel}</small></div><div className="speed-detail">{detail}</div></div>;
}
function GaugeRing({value, caption = 'Score', purple = false, digits = 2, suffix = '', progress}) {
  const fill = progress === null ? 0 : Number.isFinite(progress) ? progress : suffix === '%' ? value / 100 : value;
  const bounded = Number.isFinite(fill) ? Math.max(0, Math.min(1, fill)) : 0;
  return <div className={`gauge-ring ${purple ? 'purple' : ''}`}><svg viewBox="0 0 160 160"><circle className="gauge-track" cx="80" cy="80" r="65"/><circle className="gauge-value" cx="80" cy="80" r="65" strokeDasharray={`${bounded * 306} 409`}/></svg><div><strong>{number(value, digits, suffix)}</strong><span>{caption}</span></div></div>;
}

function Home() {
  const b = finalModel.benchmark;
  const features = [
    [Mic, 'Edge Wake-Word Detection', 'Two-stage TinyML model running locally on ESP32 for high accuracy and low false alarms.', ''],
    [Cloud, 'On-Demand ASR', 'Audio is sent to the server only after “MARVIN” is detected, minimizing latency and power.', ''],
    [Zap, 'Real-Time Visualization', 'Live audio, model confidence and system metrics on a modern web dashboard.', 'purple'],
    [Box, 'Built for Real-World Use', 'Optimized for ultra-low power edge devices with <256 KB RAM and practical deployment.', 'purple'],
  ];
  const stats = [
    [Cpu, `< ${Math.ceil(parseFloat(b.cpuDuty.replace('~','')))}%`, 'Compute Duty', 'purple'],
    [Database, `~ ${Math.round(finalModel.size.modelBytes / 1024)} KB`, 'Model Footprint', ''],
    [Gauge, `~ ${parseInt(b.candidateDecision.replace('~',''))} ms`, 'Wake Decision Latency', ''],
    [Database, `~ ${Math.round(b.staticRamBytes / 1024)} KB`, 'Static RAM Usage', 'purple'],
  ];
  return <div className="hx">
    <section className="hx-hero">
      <div className="hx-stars" aria-hidden="true"/>
      <div className="hx-art hx-backdrop">
        <img src={homeArtwork} alt="INMP441 microphone, ESP32 and OLED running the two-stage MARVIN TinyML model beside an ISRO launch pad"/>
      </div>
      <div className="hx-copy">
        <div className="hx-eyebrow"><Sih className="hx-sih"/><span>|</span>PROBLEM STATEMENT ID: 26172<span>|</span><b className="hx-isro">ISRO</b></div>
        <h1><span className="hx-wave"><WaveMark/></span><span className="hx-title">MARVIN</span></h1>
        <div className="hx-byline">by <strong>Learning Loop</strong></div>
        <h2>Low-Latency and Efficient<br/>Voice Activator for Edge Devices</h2>
        <p className="hx-lead">A two-stage TinyML wake-word detector running on ESP32, designed to listen for “MARVIN”, understand your command, and activate the cloud only when needed.</p>
        <blockquote className="hx-quote">“A smarter tomorrow,<br/>listening today.”<cite>— Team Learning Loop</cite></blockquote>
      </div>
    </section>
    <MissionBrief/>
    <LaunchSequence/>
    <div className="hx-features">{features.map(([Icon,title,description,color]) => <section className="hx-feature" key={title}><Orb icon={Icon} color={color}/><div><h3>{title}</h3><p>{description}</p></div></section>)}</div>
    <section className="hx-stats">{stats.map(([Icon,value,label,color]) => <div key={label}><Orb icon={Icon} color={color}/><div><strong>{value}</strong><span>{label}</span></div></div>)}</section>
  </div>;
}

const missionBrief = [
  [Target, 'The problem', 'PS 26172', 'Always-on voice control on edge hardware must wake instantly, run within a microcontroller\'s memory and power budget, and avoid false activations.'],
  [Rocket, 'Our approach', 'Two-stage TinyML', 'A light Stage 1 detector watches continuously; a Stage 2 temporal verifier fires only on candidates. Speech reaches ASR only after “MARVIN” is confirmed.'],
  [ShieldCheck, 'Why it matters', 'Edge first', 'Audio stays on the device until the wake word is confirmed, so the radio and the cloud model stay idle most of the time.'],
];
function MissionBrief() {
  return <section className="mission-brief" aria-label="Mission brief">{missionBrief.map(([Icon,title,tag,text],index) => <article className="panel mission-card" key={title}><header><span className="mission-index">0{index + 1}</span><Icon/><div><small>{tag}</small><h3>{title}</h3></div></header><p>{text}</p></article>)}</section>;
}
const launchSteps = [
  ['T-0', Mic, 'Ignition', 'INMP441 microphone', 'Continuous 16 kHz capture on the ESP32'],
  ['Stage 1', BrainCircuit, 'MARVIN KWS', 'Threshold 0.60', 'Log-Mel features scored every 640 ms hop'],
  ['Stage 2', Cpu, 'Temporal verifier', 'Threshold 0.65', 'Runs only for Stage 1 candidates'],
  ['Orbit', Cloud, 'Uplink', 'Wi-Fi · WebSocket', 'Pre-roll + command streamed after wake'],
  ['Payload', FileText, 'Transcript', 'faster-whisper ASR', 'Command text returned to the dashboard'],
];
function LaunchSequence() {
  return <section className="panel launch-sequence" aria-label="Two-stage launch sequence">
    <div className="launch-head"><Rocket/><div><h2>Two-Stage Launch Sequence</h2><p>Like a launch vehicle, each stage fires only when the one before it succeeds.</p></div><a className="launch-cta" href="#live-monitor"><Play/>Watch it live</a></div>
    <ol className="launch-track">{launchSteps.map(([tag,Icon,title,metric,detail]) => <li className="mission-step" key={tag}><span className="step-tag">{tag}</span><span className="step-icon"><Icon/></span><b>{title}</b><em>{metric}</em><small>{detail}</small></li>)}</ol>
  </section>;
}

function Stage({title, caption, score, threshold, digits = 2, purple, connected}) {
  return <Panel title={title} icon={purple ? Cpu : Mic} className={`stage ${purple ? 'purple' : ''}`}><p className="stage-caption">{caption}</p><div className="stage-body"><GaugeRing value={score} digits={2} purple={purple}/><div className="threshold"><span>Threshold</span><strong>{number(threshold,2)}</strong><div className="score-bar"><i style={{width:`${Number.isFinite(score) ? Math.min(100, Math.max(0, score * 100)) : 0}%`}}/></div><b>{number(Number.isFinite(score) ? score * 100 : undefined,digits,'%')}</b></div></div><div className={`stage-result ${Number.isFinite(score) && score >= threshold ? 'passed' : ''}`}>{!connected || !Number.isFinite(score) ? '--' : score >= threshold ? <><Check/> HOT</> : 'IDLE'}</div></Panel>;
}
function readLiveTelemetry(data, connected) {
  const source = connected && data.metrics?.type === 'kws' ? data.metrics : {};
  return {
    s1_score: source.s1_score, s2_score: source.s2_score,
    free_heap: source.free_heap, min_free_heap: source.min_free_heap, heap_baseline: source.heap_baseline,
    cpu_duty_percent: source.cpu_duty_percent,
    frontend_latency_ms: source.frontend_latency_ms,
    s1_latency_ms: source.s1_latency_ms, s2_latency_ms: source.s2_latency_ms,
    feature_copy_us: source.feature_copy_us,
    wake_to_asr_latency_ms: source.wake_to_asr_latency_ms,
  };
}
function DetectionPipeline({data, connected}) {
  const [visual,setVisual] = useState({stage:'idle', key:null});
  const resetTimer = useRef(null);
  const lastKey = useRef(null);
  const historyId = data.history?.[0]?.id;
  const shownTranscriptId = useRef(null);
  const sample = connected ? data.score_history?.at(-1) : null;
  const sampleKey = sample?.at;
  const backendState = connected ? data.state : null;
  const metrics = connected && data.metrics?.type === 'kws' ? data.metrics : {};
  const s1 = metrics.wake && Number.isFinite(metrics.s1) ? metrics.s1 : Number.isFinite(metrics.s1_score) ? metrics.s1_score : undefined;
  const s2 = metrics.wake && Number.isFinite(metrics.s2) ? metrics.s2 : metrics.stage2_invoked && Number.isFinite(metrics.s2_score) ? metrics.s2_score : undefined;
  const transcript = typeof data.history?.[0]?.text === 'string' && data.history[0].text.trim() ? data.history[0].text : null;
  useEffect(() => {
    clearTimeout(resetTimer.current);
    if (!connected) {lastKey.current=null; setVisual({stage:'offline',key:null}); return;}
    if (backendState === 'RESULT' && transcript && historyId !== shownTranscriptId.current) {
      shownTranscriptId.current=historyId;
      setVisual({stage:'transcript',key:historyId});
      return;
    }
    if (backendState === 'RESULT') {
      if (!transcript) setVisual({stage:'idle',key:historyId});
      return;
    }
    if (backendState === 'STREAMING_AUDIO' || backendState === 'TRANSCRIBING') {setVisual({stage:'asr',key:sampleKey}); return;}
    if (backendState === 'WAKE_DETECTED' || metrics.wake === true) {
      setVisual({stage:'confirmed',key:sampleKey});
      resetTimer.current=setTimeout(() => setVisual(current => current.stage === 'confirmed' ? {stage:'capture',key:sampleKey} : current),300);
      return () => clearTimeout(resetTimer.current);
    }
    if (!sampleKey || sampleKey === lastKey.current) return;
    lastKey.current=sampleKey;
    const timers=[];
    const step=(stage,delay) => timers.push(setTimeout(() => setVisual({stage,key:sampleKey}),delay));
    setVisual({stage:'features',key:sampleKey});
    step('s1',240);
    if (Number.isFinite(sample.s1) && sample.s1 < finalModel.thresholds.s1) {
      step('s1-failed',480); step('idle',1150);
    } else if (Number.isFinite(sample.s1)) {
      step('candidate',480);
      if (sample.stage2_invoked && Number.isFinite(sample.s2)) {
        step('s2',720);
        if (sample.s2 < finalModel.thresholds.s2) {step('s2-rejected',960); step('idle',1600);}
      }
    }
    return () => timers.forEach(clearTimeout);
  },[connected,backendState,sampleKey,historyId,transcript,metrics.wake]);
  const stage=visual.stage;
  const activeIndex={idle:0,offline:-1,features:1,s1:2,'s1-failed':2,candidate:3,s2:3,'s2-rejected':3,confirmed:4,capture:5,asr:6,transcript:7}[stage] ?? 0;
  const failed=stage==='s1-failed' ? 2 : stage==='s2-rejected' ? 3 : -1;
  const complete = index => stage==='transcript' ? index<7 : stage==='asr' ? index<6 : stage==='capture' ? index<5 : stage==='confirmed' ? index<4 : stage==='candidate' || stage==='s2' || stage==='s2-rejected' ? index<3 : index<activeIndex;
  const steps = [
    [AudioLines,'Microphone',connected ? 'Listening for MARVIN' : '--'],
    [BarChart3,'Log-Mel Features',sample ? '98 × 24 features' : '--'],
    [BrainCircuit,'Stage 1 — MARVIN KWS',`Score: ${number(s1,2)} · Threshold: 0.60${['candidate','s2','s2-rejected','confirmed','capture','asr','transcript'].includes(stage) ? ' · CANDIDATE' : stage==='s1-failed' ? ' · FAIL' : ''}`],
    [BrainCircuit,'Stage 2 — Temporal Verifier',`Score: ${number(s2,2)} · Threshold: 0.65${stage==='s2-rejected' ? ' · REJECTED' : ''}`],
    [Check,'Wake Confirmed',activeIndex>=4 ? 'MARVIN DETECTED' : '--'],
    [Mic,'Capture Audio','Pre-roll + Command'],
    [Cloud,'Send to ASR','Wi-Fi / WebSocket'],
    [FileText,'Transcript Received',stage==='transcript' ? transcript : '--'],
  ];
  return <Panel title="Detection Pipeline" icon={FileText} className="pipeline dynamic-pipeline" aside={connected ? 'LIVE BACKEND STATE' : 'ESP32 OFFLINE'}><div className="pipeline-flow">{steps.map(([Icon,title,detail],index) => {const mode = index===failed ? 'rejected' : index===activeIndex ? index===3 ? 'active-purple' : index>=4 && index<=5 ? 'active-green' : 'active' : complete(index) ? 'complete' : 'inactive'; const flow = index<activeIndex ? 'success' : index===activeIndex && index<7 ? index===3 ? 'purple' : 'processing' : 'inactive'; return <React.Fragment key={title}><div className={`pipeline-step step-${index} ${mode}`}><Icon/><div><strong>{title}</strong><span>{detail}</span></div>{index===0 && connected && stage==='idle' && <i className="pipeline-live-dot"/>}</div>{index<7 && <div className={`pipeline-connector ${flow}`} aria-hidden="true"><i/></div>}</React.Fragment>;})}</div></Panel>;
}
function LiveMonitor({data, connected, online, send}) {
  const transcriptId = data.history?.[0]?.id;
  const [expiredTranscriptId, setExpiredTranscriptId] = useState(null);
  useEffect(() => {
    if (!online || transcriptId == null) return;
    const createdAt = typeof transcriptId === 'number' ? transcriptId / 1e6 : Date.now();
    const remaining = Math.max(0, createdAt + 10000 - Date.now());
    const timer = setTimeout(() => setExpiredTranscriptId(transcriptId), remaining);
    return () => clearTimeout(timer);
  }, [online, transcriptId]);
  if (transcriptId != null && transcriptId === expiredTranscriptId) {
    data = {...data, history: []};
  }
  const metrics = connected && (data.metrics?.type === 'kws' || data.metrics?.wake === true) ? data.metrics : {}, live = readLiveTelemetry(data, connected), latest = online ? data.history?.[0] : null, test = data.kws_test || {}, active = connected && test.active;
  const freeHeapKB = Number.isFinite(live.free_heap) ? live.free_heap / 1024 : undefined;
  const minFreeHeapKB = Number.isFinite(live.min_free_heap) ? live.min_free_heap / 1024 : undefined;
  const heapBaselineKB = Number.isFinite(live.heap_baseline) && live.heap_baseline > 0 ? live.heap_baseline / 1024 : undefined;
  const freeFraction = Number.isFinite(freeHeapKB) && Number.isFinite(heapBaselineKB) ? freeHeapKB / heapBaselineKB : undefined;
  const heldOut = finalModel.heldOut;
  return <div className="live-page"><div className="live-main"><section className="panel wake-banner"><div className="mic-art"><Mic/></div>{(() => {const st = connected ? data.state : null; const listening = st === 'WAKE_DETECTED' || st === 'STREAMING_AUDIO' || metrics.wake === true; const transcribing = st === 'TRANSCRIBING'; return <div className={`wake-status ${listening ? 'listening' : transcribing ? 'transcribing' : ''}`}>{listening ? <><i>MARVIN detected</i><strong>Listening…</strong></> : transcribing ? <><i>Command received</i><strong>Transcribing…</strong></> : <><i>Say</i><strong>“MARVIN”</strong></>}</div>;})()}<div className="banner-line"/><button disabled={!connected} onClick={() => send(active ? 'KWS_TEST_STOP' : 'KWS_TEST_START')}>{active ? `Stop test · ${Math.ceil((test.remaining_ms || 0)/1000)}s` : 'Start microphone test'}</button>{test.result && <small>{test.result === 'detected' ? 'MARVIN detected' : 'No wake detected'}</small>}</section><div className="live-detector"><div className="detector-left"><div className="stage-grid"><Stage title="Stage 1 · MARVIN KWS" caption="Continuous candidate detection" score={live.s1_score} threshold={finalModel.thresholds.s1} connected={connected}/><Stage title="Stage 2 · Temporal Verifier" caption="Invoked only for Stage 1 candidates" score={metrics.stage2_invoked ? live.s2_score : undefined} threshold={finalModel.thresholds.s2} purple connected={connected}/></div><Panel title="Live Audio Waveform" icon={Activity} className="live-wave" aside={connected ? 'Frame-normalized PCM' : 'Microphone offline'}><EmptyPlot compact samples={connected ? data.waveform : null}/></Panel><Panel title="Visualization Log-Mel (48 × 24 preview)" icon={Waves} className="live-mel" aside={connected && melArray(data.spectrogram) ? 'PCM derived' : '--'}><EmptyPlot kind="mel" matrix={connected ? data.spectrogram : null} compact/></Panel></div><DetectionPipeline data={data} connected={connected}/></div></div><div className="runtime"><Panel title="Live Runtime · ESP32" icon={Cpu}><div className="runtime-gauges"><div className="ram-used"><span className="ram-used-label">RAM USED</span><strong>{Number.isFinite(freeHeapKB) ? number(finalModel.benchmark.staticRamBytes/1024 + (heapBaselineKB - freeHeapKB),1,' KiB') : '--'}</strong><div className="ram-used-bar"><i style={{width:`${Number.isFinite(freeHeapKB) ? Math.min(100,(finalModel.benchmark.staticRamBytes/1024 + (heapBaselineKB - freeHeapKB))/320*100) : 0}%`}}/></div><small>of 320 KiB · {Number.isFinite(freeHeapKB) ? <b className="ram-low">LOW</b> : '--'} · free {number(freeHeapKB,1,' KiB')}</small></div><Speedometer title="CPU DUTY" value={live.cpu_duty_percent} unit="%" caption="KWS DUTY" ratio={Number.isFinite(live.cpu_duty_percent) ? live.cpu_duty_percent / 10 : undefined} tone="cpu" leftLabel="0%" rightLabel="10% LIMIT" detail="Continuous microphone · 640 ms cascade hop"/></div></Panel><Panel title="MARVIN Best INT8 · Results" icon={BarChart3}><Rows items={[['Accuracy','99.65%'],['Precision','95.9%'],['Recall','95.1%'],['F1 Score','95.5%'],['Parameters','20,734']]}/></Panel><Panel title="Live Latency" icon={Zap}><Rows items={[[ 'Wake → ASR Stream',number(live.wake_to_asr_latency_ms,2,' ms')],['Frontend Latency',number(live.frontend_latency_ms,2,' ms')],['Stage 1 Latency',number(live.s1_latency_ms,2,' ms')],['Stage 2 Latency',number(live.s2_latency_ms,2,' ms')],['Feature Copy',number(metrics.stage2_invoked ? live.feature_copy_us : undefined,2,' µs')]]}/></Panel></div><div className="live-bottom"><Panel title="Recent Events" icon={Clock}><div className="events">{online && data.events?.length ? data.events.slice(0,5).map((event,index) => <div key={index}><time>{event.at}</time><i/>{event.message}</div>) : <p>--</p>}</div></Panel><Panel title="Latest Transcript" icon={FileText} aside={latest?.at}><blockquote>{latest?.text ? `“${latest.text}”` : '--'}</blockquote></Panel><Panel title="Live Confidence Plot" icon={Activity} aside={<><span className="dot"/> Stage 1 <span className="dot purple"/> Stage 2</>}><EmptyPlot kind="confidence" history={connected ? data.score_history : []} label="Waiting for detector output" compact/></Panel></div></div>;
}

function Comparison({data, online}) {
  const live = online && data.esp32_connected && data.metrics?.type === 'kws' ? data.metrics : null;
  return <div className="comparison-page focused-comparison">
    <section className="panel comparison-headline"><div><span className="comparison-eyebrow">OUR FINAL MODEL · CONTINUOUS MICROPHONE MONITORING</span><h2>MARVIN Best INT8</h2><p>99.65% accuracy · 20,734 parameters · running on the connected ESP32.</p></div><div className="headline-kpis">{[['99.65%','Accuracy'],['20,734','Parameters'],['27.65 KiB','Model size'],['~7.5%','CPU duty']].map(([value,label])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div><div className="comparison-headline-badges"><span className="final-badge">CURRENTLY DEPLOYED</span>{live && <span className="final-badge">LIVE · {number(live.total_duty_percent,2,'% KWS DUTY')}</span>}</div></section>
    <div className="comparison-table-wrap"><section className="panel model-table"><table><thead><tr><th>Parameter</th>{comparisonModels.map(model=><th key={model.id} className={model.final?'final':'reference'}>{model.name}{!model.final && <span>Published reference</span>}</th>)}</tr></thead><tbody>{comparisonFields.map(([label,key])=><tr key={key}><th>{label}</th>{comparisonModels.map(model=><td key={model.id} className={`${model.final?'final':'reference'} ${/^(Not |Platform|Hardware)/.test(model[key])?'muted':''} ${/^✓/.test(model[key])?'yes':/^✗/.test(model[key])?'no':''}`}><span className="comparison-cell-value">{model[key]}</span></td>)}</tr>)}</tbody></table></section></div>
    <p className="comparison-note">** Espressif published ESP-SR benchmark for WakeNet9 (ESP32-S3 with PSRAM). MLPerf Tiny DS-CNN figures are from the open-source MLPerf Tiny keyword-spotting benchmark. <a href="https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html" target="_blank" rel="noreferrer">Espressif benchmark ↗</a> · <a href="https://github.com/mlcommons/tiny/tree/master/benchmark/training/keyword_spotting" target="_blank" rel="noreferrer">MLPerf Tiny KWS ↗</a></p>
    
    <div className="comparison-charts bar-charts">{comparisonCharts.map(chart=><BarChart key={chart.title} {...chart}/>)}</div>
  </div>;
}

function Dataset({data, online}) {
  const positiveShare = corpus.positive / corpus.total * 100;
  const gradient = `#00edff 0% ${positiveShare}%,#061a30 ${positiveShare}% calc(${positiveShare}% + .6%),#1f5fa6 calc(${positiveShare}% + .6%) 100%`;
  const confusers = corpus.confusers;
  const collectorFiles = online ? data.dataset?.total_wav_files : undefined;
  return <div className="dataset-page">
    <section className="panel dataset-intro"><Database/><div><h2>Google Speech Commands v2 + MARVIN</h2><p>Base Dataset: Google Speech Commands v2 — 105,829 one-second speech recordings, 35 words, 16 kHz audio.<br/>Official Test: 11,005 clips — kept locked during development.</p></div><div className="dataset-benefits">{[[Target,'MARVIN clips','2,100 wake-word clips'],[ShieldCheck,'DEV + Validation','100 DEV · 95 validation MARVIN clips'],[Mic,'Background noise','6 recordings · about 6.66 minutes']].map(([Icon,title,description])=><div key={title}><Icon/><div><b>{title}</b><small>{description}</small></div></div>)}</div></section>
    <div className="dataset-top"><Panel title="Dataset Composition" icon={CircleGauge} className="composition"><div className="composition-body"><div className="donut" style={{background:`conic-gradient(${gradient})`}}><div>Total<strong>105,829</strong>clips</div></div><div className="composition-legend">{corpus.classes.map(([name,count],index)=><div key={name}><i style={{background:index?'#3478bc':'#16c5ec'}}/><span>{name}<small>{number(count)} clips</small></span></div>)}<div className="hard-negative-focus"><b>Base audio</b><span>35 words · 16 kHz</span><small>One-second speech recordings.</small></div></div></div></Panel>
    <Panel title="Dataset Splits" icon={ShieldCheck} className="sources">{corpus.splits.map(split=><div className="source" key={split.name}><Database/><div><b>{split.name}</b><span>{number(split.total)} total audio clips</span><small>{number(split.positive)} MARVIN clips</small></div></div>)}</Panel>
    <Panel title="Confuser Dataset" icon={Target} className="sources">{confusers.map(([label,count])=><div className="source" key={label}><AudioLines/><div><b>{number(count)} clips</b><span>{label}</span></div></div>)}</Panel></div>
    <div className="dataset-bottom"><Panel title="Dataset Details" icon={FileText} className="dataset-details"><div className="table-scroll"><table><thead><tr>{['Split','MARVIN Clips','Total Audio Clips'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{corpus.splits.map(split=><tr key={split.name}><td>{split.name}</td><td>{number(split.positive)}</td><td>{number(split.total)}</td></tr>)}<tr><td>Total MARVIN</td><td>2,100</td><td>—</td></tr></tbody></table></div></Panel>
    <Panel title="Base Dataset" icon={Database} className="augmentation"><Rows items={[[ 'Dataset','Google Speech Commands v2'],['Speech recordings','105,829'],['Words','35'],['Sample rate','16 kHz'],['Clip duration','1 second']]}/></Panel>
    <Panel title="MARVIN Split" icon={Target} className="dataset-preview"><div className="hard-negative-list">{corpus.splits.map(split=><section key={split.name}><h3>{split.name.toUpperCase()}</h3><span>{number(split.positive)} clips</span></section>)}</div></Panel></div>
    <section className="panel dataset-takeaways"><Orb icon={Lightbulb}/><h2>Dataset Notes</h2><ul><li>DEV and Validation split the original 9,981-clip validation pool into 4,822 and 5,159 clips.</li><li>Confuser counts are tracked separately from the base corpus totals.</li><li>Background noise: 6 recordings, about 6.66 minutes.</li><li>Live collector WAV files: {number(collectorFiles)} reported by the backend. <a href={`${backendHttp}/api/dataset/status`} target="_blank" rel="noreferrer">Dataset status ↗</a></li></ul></section>
  </div>;
}

function App() {
  const backend = useBackend(), [page, setPage] = useState(() => pages.find(item => item.id === location.hash.slice(1))?.id || 'home');
  useEffect(() => {const change = () => setPage(pages.find(item => item.id === location.hash.slice(1))?.id || 'home'); window.addEventListener('hashchange',change); return () => window.removeEventListener('hashchange',change);}, []);
  const current = pages.find(item => item.id === page), subtitles = {'live-monitor':'Real-Time Voice Detection and Transcription','model-comparison':'Comparing TinyML Models for “MARVIN” Wake-Word Detection',dataset:'Hybrid Dataset for Wake-Word Detection'};
  useEffect(() => {document.title = `${current.name} · MARVIN | Learning Loop`;}, [current.name]);
  const canvas = useRef(null), appRef = useRef(null), mainRef = useRef(null);
  useEffect(() => mountScene(canvas.current), []);
  useEffect(() => mountTilt(appRef.current), []);
  useEffect(() => mountCursor(), []);
  useEffect(() => {
    staggerReveal(mainRef.current); countUp(mainRef.current);
    return mountHeroParallax(mainRef.current.querySelector('.hx-hero'));
  }, [page]);
  const liveMetrics = backend.connected ? backend.data.metrics || {} : {};
  const liveScore = liveMetrics.wake === true ? 1 : Math.max(Number(liveMetrics.s1_score ?? liveMetrics.s1) || 0, Number(liveMetrics.s2_score ?? liveMetrics.s2) || 0);
  useEffect(() => setSceneEnergy(liveScore), [liveScore]);
  const Page = {home:Home,'live-monitor':LiveMonitor,'model-comparison':Comparison,dataset:Dataset}[page];
  return <div ref={appRef} className={`app page-${page}`}><canvas ref={canvas} className="scene3d" aria-hidden="true"/><div className="scene-vignette" aria-hidden="true"/><aside className="sidebar"><Brand/><nav aria-label="Main navigation">{pages.map(({id,name,icon:Icon}) => <a key={id} href={`#${id}`} className={id === page ? 'active' : ''} aria-current={id === page ? 'page' : undefined}><Icon/><span>{name}</span></a>)}</nav><div className="sidebar-landscape"/><blockquote>“A smarter<br/> tomorrow,<br/> listening today.”<cite>— Team Learning Loop</cite></blockquote><div className="institute"><BrainCircuit/><span>PSG Institute of<br/>Technology and<br/>Applied Research</span></div></aside><div className="workspace"><header className="page-header"><div className="header-earth"/>{page !== 'home' && <div className="page-heading">{page === 'dataset' ? <Database/> : <AudioLines/>}<div><h1>{current.name.split(' ').map((word,index) => <React.Fragment key={word}>{index > 0 && ' '}<span className={index > 0 || page === 'dataset' ? 'accent' : ''}>{word}</span></React.Fragment>)}</h1><p>{subtitles[page]}</p></div></div>}<div className="header-status">{page !== 'home' && <span className="event-badge">SIH 2026 | Problem Statement ID: 26172</span>}<Status active={backend.online}>Backend {backend.online ? 'Online' : 'Offline'}</Status><Status active={backend.connected}>ESP32 {backend.connected ? 'Online' : 'Offline'}</Status><Status active={backend.online && backend.data.asr_online === true}>ASR {backend.online && backend.data.asr_online === true ? 'Online' : 'Offline'}</Status><Sih className="header-sih"/><Isro/></div></header><main ref={mainRef} key={page}><Page {...backend}/></main></div><footer><Brand small/><div className="motto">LISTEN · LEARN · LOOP · BUILD</div><span><img className="footer-sih" src={sihLogo} alt="" width="60" height="30"/>SIH 2026 <i/> Building a Smarter India</span></footer></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
