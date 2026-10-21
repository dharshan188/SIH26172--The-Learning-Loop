#!/usr/bin/env python3
import json,pathlib,re,statistics
root=pathlib.Path(__file__).resolve().parents[1]/'hardware_runs'
rows=[]
current=None
boot=0
for line in (root/'serial.jsonl').read_text().splitlines():
    try:r=json.loads(line)
    except json.JSONDecodeError:continue
    s=r['line']
    if s.startswith('MARVIN /'):
        boot+=1;current=None;continue
    m=re.search(r'Window (\d+): raw_int8=(-?\d+), probability=([\d.]+), MARVIN (detected|not detected)',s)
    if m:
        current=dict(boot=boot,sequence=int(m[1]),raw=int(m[2]),probability=float(m[3]),detected=m[4]=='detected',time=r['time']);rows.append(current)
    if current is None:continue
    m=re.search(r'preprocessing=(\d+) us .*inference=(\d+) us',s)
    if m:current.update(preprocess_us=int(m[1]),inference_us=int(m[2]))
    m=re.search(r'capture_wall=([\d.]+) ms, total_cycle_capture_to_result=([\d.]+) ms, processing=([\d.]+) ms',s)
    if m:current.update(capture_ms=float(m[1]),cycle_ms=float(m[2]),processing_ms=float(m[3]))
    m=re.search(r'peak=([\d.]+), skipped_windows=(\d+), DMA_overflows=(\d+)',s)
    if m:current.update(peak=float(m[1]),skipped=int(m[2]),overflows=int(m[3]))
    m=re.search(r'free_heap=(\d+), minimum_free_heap=(\d+), largest_free_block=(\d+)',s)
    if m:current.update(free_heap=int(m[1]),min_heap=int(m[2]),largest_block=int(m[3]))
    m=re.search(r'approximate_runtime_RAM=(\d+)',s)
    if m:current['runtime_ram']=int(m[1])
    m=re.search(r'arena_reserved=(\d+), arena_used=(\d+)',s)
    if m:current.update(arena_reserved=int(m[1]),arena_used=int(m[2]))
rows=[r for r in rows if 'arena_used' in r and r['boot']==boot]
(root/'windows.json').write_text(json.dumps(rows,indent=2))
print('complete_windows',len(rows))
if rows:
    for key in ['inference_us','preprocess_us','processing_ms','cycle_ms','peak','probability','raw']:
        values=[r[key] for r in rows];print(key,'min',min(values),'avg',statistics.mean(values),'max',max(values))
    print('detections',sum(r['detected'] for r in rows))
    print('latest',json.dumps(rows[-1]))
