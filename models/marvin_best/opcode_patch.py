"""Replace BATCH_MATMUL builtin opcode with CUSTOM 'BatchMatMul'.
Appends: string, OperatorCode table+vtable, new operator_codes offset-vector.
Patches: model.operator_codes slot (uoffset), 2x Operator.opcode_index (uint)."""
import struct
from tflite.Model import Model
SRC='/tmp/marvin_best/marvin_best_model/model/marvin_best_int8.tflite'
DST='/tmp/marvin_best/marvin_best_int8_custombm.tflite'
CUSTOM_NAME=b'BatchMatMul'; BATCH=126; CUSTOM=32

orig=open(SRC,'rb').read()
buf=bytearray(orig)
m=Model.GetRootAs(buf,0)
assert m.Version()==3
ncode=m.OperatorCodesLength()
codes=[m.OperatorCodes(i).BuiltinCode() for i in range(ncode)]
assert BATCH in codes
sg=m.Subgraphs(0)
targets=[]
for n in range(sg.OperatorsLength()):
    if codes[sg.Operators(n).OpcodeIndex()]==BATCH:
        targets.append(n)
print('batchmatmul ops:',targets,'of',sg.OperatorsLength())
assert len(targets)==2

# model.operator_codes slot: field id 1 -> voffset 6
tab=m._tab
slot=tab.Pos+tab.Offset(6)
vec=struct.unpack_from('<i',buf,slot)[0]+slot
vlen=struct.unpack_from('<I',buf,vec)[0]
assert vlen==ncode
offs=[struct.unpack_from('<i',buf,vec+4+4*i)[0]+vec+4+4*i for i in range(vlen)]

assert len(buf)%4==0
# 1. string
S=len(buf)
buf+=struct.pack('<I',len(CUSTOM_NAME))+CUSTOM_NAME+b'\x00'
# 2. OperatorCode table at T (builtin=32, custom->S, version=1)
T=len(buf)
buf+=struct.pack('<i',0)          # soffset placeholder
buf+=struct.pack('<b',CUSTOM)+b'\x00\x00\x00'
buf+=struct.pack('<i',0)          # custom_code placeholder
buf+=struct.pack('<i',1)          # version
V=len(buf)
vtable=struct.pack('<HHhhh',10,16,4,8,12)
buf+=vtable; buf+=b'\x00\x00'     # pad vtable 10->12
struct.pack_into('<i',buf,T,T-V)  # soffset: vtable = table - soffset
struct.pack_into('<i',buf,T+8,S-(T+8))  # custom_code uoffset
# 3. new operator_codes vector
G=len(buf)
buf+=struct.pack('<I',ncode+1)
for o in offs:
    pos=len(buf); buf+=struct.pack('<i',o-pos)
pos=len(buf); buf+=struct.pack('<i',T-pos)
struct.pack_into('<i',buf,slot,G-slot)
# 4. repoint the two operators (field id 0 -> voffset 4)
for n in targets:
    ot=sg.Operators(n)._tab
    op_slot=ot.Pos+ot.Offset(4)
    old=struct.unpack_from('<I',buf,op_slot)[0]
    assert old==11, old
    struct.pack_into('<I',buf,op_slot,ncode)
open(DST,'wb').write(buf)
print('wrote',DST,len(buf),'bytes (orig',len(orig),')')

# verify reload (manual decode: this flatbuffers-python cannot follow the
# backward uoffsets of the appended table vector; C++ readers wrap correctly)
b2=bytearray(open(DST,'rb').read())
G2=len(b2)-(4+4*(ncode+1))
assert struct.unpack_from('<I',b2,G2)[0]==ncode+1, 'new vector len'
tabs2=[G2+4+4*i+struct.unpack_from('<i',b2,G2+4+4*i)[0] for i in range(ncode+1)]
T2=tabs2[ncode]
V2=T2-struct.unpack_from('<i',b2,T2)[0]
assert struct.unpack_from('<HHhhh',b2,V2)==(10,16,4,8,12)
assert struct.unpack_from('<b',b2,T2+4)[0]==CUSTOM
co2=T2+8+struct.unpack_from('<i',b2,T2+8)[0]
assert struct.unpack_from('<I',b2,co2)[0]==len(CUSTOM_NAME) and bytes(b2[co2+4:co2+4+len(CUSTOM_NAME)])==CUSTOM_NAME
assert struct.unpack_from('<i',b2,T2+12)[0]==1
m2=Model.GetRootAs(b2,0)
s2=m2.Subgraphs(0)
assert s2.OperatorsLength()==sg.OperatorsLength()
for n in range(s2.OperatorsLength()):
    assert s2.Operators(n).OpcodeIndex()==(ncode if n in targets else sg.Operators(n).OpcodeIndex())
print('PATCH OK')
