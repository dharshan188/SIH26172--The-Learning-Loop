// Fixed evaluation and historical benchmark results. Live runtime values come
// only from /ws/dashboard and must never be filled from this object.
const stage2Bytes = 11056;
const stage2Parameters = 1393;
const referenceOverheadBytes = stage2Bytes - stage2Parameters;

const estimatedSize = parameters => ({
  bytes: parameters + referenceOverheadBytes,
  label: `~${((parameters + referenceOverheadBytes) / 1024).toFixed(1)} KB est.`,
  source: 'INT8 weights plus deployed Stage 2 TFLite overhead; architecture-specific overhead is unknown',
});

export const modelMetrics = {
  validation: [
    {name: 'Micro CNN', parameters: 597, macs: 5800, precision: 97.98, recall: 98.37, f1: 98.17, size: estimatedSize(597), status: 'Experimental'},
    {name: 'Tiny Transformer', parameters: 945, macs: 13100, precision: 97.98, recall: 98.37, f1: 98.17, size: estimatedSize(945), status: 'Experimental'},
    {name: 'Position-Aware Transformer', parameters: 1049, macs: 14400, precision: 97.98, recall: 98.37, f1: 98.17, size: estimatedSize(1049), status: 'Experimental'},
    {name: 'Temporal CNN', parameters: stage2Parameters, macs: 26600, precision: 98.78, recall: 98.37, f1: 98.57,
      size: {bytes: stage2Bytes, label: '10.8 KB measured', source: 'Embedded deployed Stage 2 model, 11,056 bytes'}, status: 'Deployed Stage 2 component'},
    {name: 'Tiny Conformer', parameters: 2162, macs: 29000, precision: 95.70, recall: 99.593, f1: 97.61, size: estimatedSize(2162), status: 'Experimental'},
  ],
  final: {
    name: 'MARVIN Best INT8',
    architecture: 'DS-CNN + Tiny Temporal Transformer',
    // INT8 official test after freeze (marvin_best_model/FINAL_REPORT.txt).
    heldOut: {accuracy: 99.65, precision: 93.82, recall: 85.64, f1: 89.54, tp: 167, tn: 10799, fp: 11, fn: 28, fpr: 0.102},
    validation: {accuracy: 99.65, precision: 94.25, recall: 86.32, f1: 90.11},
    parameters: 20734, macs: 1283176,
    // 53,712-byte model + 112-byte custom BatchMatMul opcode patch embedded in firmware.
    size: {modelBytes: 53712, embeddedBytes: 53824, label: '52.45 KiB measured'},
    // Measured on ESP32-WROOM-32 (2026-09-30 boot log / MARVIN BENCHMARK).
    // Measured on ESP32-WROOM-32, continuous monitoring: every 160 ms window scored, 0 dropped (2026-09-30).
    benchmark: {staticRam: '121.1 KiB', staticRamBytes: 124036, arenaUsedBytes: 25964, arenaReservedBytes: 32768,
      inference: '84.2 ms', inferenceMs: 84.2, frontend: '8.5 ms', frontendMs: 8.5, total: '92.7 ms', totalMs: 92.7,
      hopMs: 160, cpuDuty: '57.9%', cpuDutyPercent: 57.9},
    threshold: 0.60, calibShift: -0.05234375, rawThreshold: 0.65234375, hotWindows: 1, cooldownMs: 2000,
  },
};

// Dashboard summary: evaluation provenance stays separate from live firmware.
export const dashboardModelSummary = {
  accuracy: 99.65,
  parameters: 20734,
  reportSource: 'MARVIN Best INT8 official test',
  precision: 95.9,
  recall: 95.1,
  f1: 95.5,
};

export const datasetMetrics = {
  name: 'Google Speech Commands v2', total: 105829, positive: 2100,
  negative: 103729, words: 35, sampleRate: 16000,
  backgroundRecordings: 6, backgroundMinutes: 6.66,
  classes: [['MARVIN',2100],['OTHER CLIPS',103729]],
  splits: [
    {name:'Train',total:84843,positive:1710,negative:83133},
    {name:'DEV',total:4822,positive:100,negative:4722},
    {name:'Validation',total:5159,positive:95,negative:5064},
    {name:'Official Test',total:11005,positive:195,negative:10810},
  ],
  confusers: [
    ['Real confusers · Training',247],['Real confusers · Held-out',60],
    ['Synthetic confusers · Training',384],['Synthetic confusers · Evaluation',96],
  ],
};
