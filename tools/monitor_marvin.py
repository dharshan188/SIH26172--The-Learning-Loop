#!/usr/bin/env python3
"""Read-only host logger; does not alter detector behavior."""
import datetime,json,pathlib,serial,time
root=pathlib.Path(__file__).resolve().parents[1]/'hardware_runs'
port=serial.Serial('/dev/ttyUSB0',115200,timeout=1)
with (root/'serial.jsonl').open('a',buffering=1) as structured, (root/'serial.log').open('a',buffering=1) as raw:
    port.dtr=False
    port.rts=True
    time.sleep(.1)
    port.rts=False
    while True:
        line=port.readline().decode('utf-8',errors='replace').rstrip('\r\n')
        if line:
            timestamp=time.time()
            record={'time':timestamp,'utc':datetime.datetime.fromtimestamp(timestamp,datetime.timezone.utc).isoformat(),'line':line}
            structured.write(json.dumps(record)+'\n')
            raw.write(record['utc']+' '+line+'\n')
