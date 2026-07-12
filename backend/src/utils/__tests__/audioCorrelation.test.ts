import {
  estimateAudioOffset,
  estimateLatencyMsFromPcm,
} from '../audioCorrelation';

function deterministicSignal(length: number): Float64Array {
  let state = 0x12345678;
  return Float64Array.from({ length }, (_, index) => {
    state = (1664525 * state + 1013904223) >>> 0;
    const noise = (state / 0xffffffff) * 2 - 1;
    return noise * 0.7 + Math.sin(index * 0.071) * 0.3;
  });
}

describe('estimateAudioOffset', () => {
  it('finds a delayed, quieter copy of a calibration signal', () => {
    const reference = deterministicSignal(4_096);
    const delaySamples = 173;
    const recorded = new Float64Array(reference.length + delaySamples + 64);

    for (let index = 0; index < reference.length; index++) {
      recorded[index + delaySamples] = reference[index] * 0.35 + 0.08;
    }

    const result = estimateAudioOffset(reference, recorded, 512);

    expect(result.offsetSamples).toBe(delaySamples);
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it('reports a negative offset when the test starts before the reference', () => {
    const fullSignal = deterministicSignal(4_096);
    const test = fullSignal.slice(211);
    const result = estimateAudioOffset(fullSignal, test, 512);

    expect(result.offsetSamples).toBe(-211);
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it('does not claim confidence for unrelated silence', () => {
    const result = estimateAudioOffset(
      deterministicSignal(1_024),
      new Float64Array(1_024),
      128
    );

    expect(result.confidence).toBe(0);
  });
});

describe('estimateLatencyMsFromPcm', () => {
  it('measures a repeated calibration signal within one millisecond', () => {
    const sampleRate = 44_100;
    const source = deterministicSignal(sampleRate * 2);
    const reference = Int16Array.from(source, sample => Math.round(sample * 12_000));

    const delaySamples = 1_323; // exactly 30 ms at 44.1 kHz
    const test = new Int16Array(reference.length + delaySamples);
    for (let index = 0; index < reference.length; index++) {
      test[index + delaySamples] = Math.round(reference[index] * 0.4);
    }

    const estimate = estimateLatencyMsFromPcm(
      { samples: reference, sampleRate },
      { samples: test, sampleRate }
    );

    expect(estimate.offsetMs).toBeCloseTo(30, 0);
    expect(estimate.confidence).toBeGreaterThan(0.8);
  });
});
