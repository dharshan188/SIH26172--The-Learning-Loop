#pragma once
// Custom TFLM BatchMatMul for the MARVIN best INT8 model.
//
// The installed TFLM (Chirale 2.0.0) has no BatchMatMul kernel, so the two
// attention matmuls were retargeted to custom op "BatchMatMul" (flatbuffer
// opcode swap; math unchanged). This file implements them with a reference
// quantized batch matmul: no adjoints, int8 in/out, per-tensor quantization.
//
// The pure function batch_matmul_int8() has no TFLM dependencies so the math
// can be unit-tested on the host.
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace marvin_bm {

// C = quantize(A @ B) over shared batch dims. a_dims/b_dims/o_dims are
// row-major dim arrays of length rank (>=2); last two dims are MxK, KxN, MxN.
inline bool batch_matmul_int8(const int8_t* a, const int* a_dims, int a_rank,
                              float a_scale, int a_zp, const int8_t* b,
                              const int* b_dims, int b_rank, float b_scale,
                              int b_zp, int8_t* out, const int* o_dims,
                              int o_rank, float o_scale, int o_zp) {
  if (a_rank < 2 || b_rank < 2 || o_rank < 2) return false;
  if (a_rank != b_rank || a_rank != o_rank) return false;
  const int m = a_dims[a_rank - 2], k = a_dims[a_rank - 1];
  if (b_dims[b_rank - 2] != k) return false;
  const int n = b_dims[b_rank - 1];
  if (o_dims[o_rank - 2] != m || o_dims[o_rank - 1] != n) return false;
  int batches = 1;
  for (int i = 0; i < a_rank - 2; ++i) {
    if (a_dims[i] != b_dims[i] || a_dims[i] != o_dims[i]) return false;
    batches *= a_dims[i];
  }
  const double mult = static_cast<double>(a_scale) * static_cast<double>(b_scale) /
                      static_cast<double>(o_scale);
  const int a_stride = m * k, b_stride = k * n, o_stride = m * n;
  for (int t = 0; t < batches; ++t) {
    const int8_t* ab = a + t * a_stride;
    const int8_t* bb = b + t * b_stride;
    int8_t* ob = out + t * o_stride;
    for (int i = 0; i < m; ++i) {
      for (int j = 0; j < n; ++j) {
        int32_t acc = 0;
        for (int p = 0; p < k; ++p)
          acc += (static_cast<int32_t>(ab[i * k + p]) - a_zp) *
                 (static_cast<int32_t>(bb[p * n + j]) - b_zp);
        const double scaled = static_cast<double>(acc) * mult + o_zp;
        long q = lround(scaled);
        if (q < -128) q = -128;
        if (q > 127) q = 127;
        ob[i * n + j] = static_cast<int8_t>(q);
      }
    }
  }
  return true;
}

}  // namespace marvin_bm

#ifdef MARVIN_BM_TFLM
#include <tensorflow/lite/c/common.h>
#include <tensorflow/lite/micro/kernels/kernel_util.h>
#include <tensorflow/lite/micro/micro_context.h>

namespace marvin_bm {
struct OpDataBM {
  float a_scale, b_scale, o_scale;
  int32_t a_zp, b_zp, o_zp;
};
inline void* bm_init(TfLiteContext* context, const char*, size_t) {
  return context->AllocatePersistentBuffer(context, sizeof(OpDataBM));
}
inline void bm_free(TfLiteContext*, void*) {}
inline TfLiteStatus bm_prepare(TfLiteContext* context, TfLiteNode* node) {
  if (node->inputs->size != 2 || node->outputs->size != 1) return kTfLiteError;
  tflite::MicroContext* mc = tflite::GetMicroContext(context);
  TfLiteTensor* a = mc->AllocateTempInputTensor(node, 0);
  TfLiteTensor* b = mc->AllocateTempInputTensor(node, 1);
  TfLiteTensor* o = mc->AllocateTempOutputTensor(node, 0);
  if (!a || !b || !o) return kTfLiteError;
  const bool ok = a->type == kTfLiteInt8 && b->type == kTfLiteInt8 && o->type == kTfLiteInt8;
  OpDataBM* data = static_cast<OpDataBM*>(node->user_data);
  if (ok && data) {
    data->a_scale = a->params.scale; data->a_zp = a->params.zero_point;
    data->b_scale = b->params.scale; data->b_zp = b->params.zero_point;
    data->o_scale = o->params.scale; data->o_zp = o->params.zero_point;
  }
  mc->DeallocateTempTfLiteTensor(a);
  mc->DeallocateTempTfLiteTensor(b);
  mc->DeallocateTempTfLiteTensor(o);
  return ok ? kTfLiteOk : kTfLiteError;
}
inline TfLiteStatus bm_invoke(TfLiteContext* context, TfLiteNode* node) {
  const OpDataBM* data = static_cast<const OpDataBM*>(node->user_data);
  if (!data) return kTfLiteError;
  const TfLiteEvalTensor* a = tflite::micro::GetEvalInput(context, node, 0);
  const TfLiteEvalTensor* b = tflite::micro::GetEvalInput(context, node, 1);
  TfLiteEvalTensor* o = tflite::micro::GetEvalOutput(context, node, 0);
  if (!a || !b || !o) return kTfLiteError;
  // TfLiteIntArray layout: size followed by data[].
  const bool ok = batch_matmul_int8(
      tflite::micro::GetTensorData<int8_t>(a), a->dims->data, a->dims->size,
      data->a_scale, data->a_zp,
      tflite::micro::GetTensorData<int8_t>(b), b->dims->data, b->dims->size,
      data->b_scale, data->b_zp,
      tflite::micro::GetTensorData<int8_t>(o), o->dims->data, o->dims->size,
      data->o_scale, data->o_zp);
  return ok ? kTfLiteOk : kTfLiteError;
}
inline TfLiteRegistration* register_custom_batch_matmul() {
  static TfLiteRegistration reg{};
  reg.init = bm_init;
  reg.free = bm_free;
  reg.prepare = bm_prepare;
  reg.invoke = bm_invoke;
  return &reg;
}
}  // namespace marvin_bm
#endif  // MARVIN_BM_TFLM
