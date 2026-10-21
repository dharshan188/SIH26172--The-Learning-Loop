#!/usr/bin/env python3
"""Requires pip install tflite; verifies header bytes and lists actual operators."""
import hashlib
import pathlib
import re
import tflite
p = pathlib.Path(__file__).resolve().parents[1] / 'arduino/MarvinWakeWord/marvin_model_data.h'
b = bytes(int(v, 16) for v in re.findall(r'0x([0-9a-fA-F]{2})', p.read_text()))
assert len(b) == 17256
model = tflite.Model.GetRootAsModel(b, 0)
names = {v: k for k, v in vars(tflite.BuiltinOperator).items() if isinstance(v, int)}
print('bytes:', len(b), 'sha256:', hashlib.sha256(b).hexdigest())
for i in range(model.OperatorCodesLength()):
    op = model.OperatorCodes(i)
    print(names[op.BuiltinCode()], 'version', op.Version())
g = model.Subgraphs(0)
for label, index in [('input', g.Inputs(0)), ('output', g.Outputs(0))]:
    tensor = g.Tensors(index)
    q = tensor.Quantization()
    print(label, tensor.ShapeAsNumpy(), 'type', tensor.Type(), 'scale', q.ScaleAsNumpy(), 'zero', q.ZeroPointAsNumpy())
