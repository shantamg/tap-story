export interface AudioOffsetEstimate {
  /** Positive when the test signal occurs later than the reference. */
  offsetSamples: number;
  /** Absolute normalized correlation in the range 0...1. */
  confidence: number;
}

export interface PcmData {
  samples: Int16Array;
  sampleRate: number;
}

function mean(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;

  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    sum += samples[index];
  }
  return sum / samples.length;
}

/**
 * Estimate the sample offset between two related signals with normalized
 * cross-correlation. This is intentionally pure so synthetic and captured
 * calibration signals can use exactly the same implementation.
 */
export function estimateAudioOffset(
  reference: ArrayLike<number>,
  test: ArrayLike<number>,
  maxOffsetSamples: number
): AudioOffsetEstimate {
  if (reference.length === 0 || test.length === 0) {
    return { offsetSamples: 0, confidence: 0 };
  }

  const boundedMaxOffset = Math.max(0, Math.floor(maxOffsetSamples));
  const referenceMean = mean(reference);
  const testMean = mean(test);
  const minimumOverlap = Math.max(
    32,
    Math.floor(Math.min(reference.length, test.length) / 4)
  );

  let bestOffset = 0;
  let bestCorrelation = 0;

  for (let offset = -boundedMaxOffset; offset <= boundedMaxOffset; offset++) {
    const referenceStart = Math.max(0, -offset);
    const testStart = Math.max(0, offset);
    const overlap = Math.min(
      reference.length - referenceStart,
      test.length - testStart
    );
    if (overlap < minimumOverlap) continue;

    let dotProduct = 0;
    let referenceEnergy = 0;
    let testEnergy = 0;

    for (let index = 0; index < overlap; index++) {
      const referenceValue = reference[referenceStart + index] - referenceMean;
      const testValue = test[testStart + index] - testMean;
      dotProduct += referenceValue * testValue;
      referenceEnergy += referenceValue * referenceValue;
      testEnergy += testValue * testValue;
    }

    const energy = Math.sqrt(referenceEnergy * testEnergy);
    const correlation = energy > 0 ? Math.abs(dotProduct / energy) : 0;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  return {
    offsetSamples: bestOffset,
    confidence: Math.min(1, bestCorrelation),
  };
}

function createOnsetEnvelope(
  samples: Int16Array,
  blockSize: number,
  maxSamples: number
): Float64Array {
  const sampleCount = Math.min(samples.length, maxSamples);
  const blockCount = Math.ceil(sampleCount / blockSize);
  const envelope = new Float64Array(blockCount);

  let previousSample = sampleCount > 0 ? samples[0] : 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const sample = samples[sampleIndex];
    envelope[Math.floor(sampleIndex / blockSize)] += Math.abs(sample - previousSample);
    previousSample = sample;
  }

  return envelope;
}

/** Estimate route delay from related PCM using an onset envelope and NCC. */
export function estimateLatencyMsFromPcm(
  reference: PcmData,
  test: PcmData,
  maxLatencyMs = 1_000
): { offsetMs: number; confidence: number } {
  if (reference.sampleRate !== test.sampleRate) {
    throw new Error('Sample rates do not match in calibration files');
  }

  const sampleRate = reference.sampleRate;
  const blockSize = Math.max(1, Math.round(sampleRate / 2_000));
  const maxSamples = Math.round(sampleRate * 10);
  const referenceEnvelope = createOnsetEnvelope(reference.samples, blockSize, maxSamples);
  const testEnvelope = createOnsetEnvelope(
    test.samples,
    blockSize,
    maxSamples + Math.round(sampleRate * maxLatencyMs / 1_000)
  );
  const maxOffsetBlocks = Math.ceil(maxLatencyMs * sampleRate / 1_000 / blockSize);
  const estimate = estimateAudioOffset(
    referenceEnvelope,
    testEnvelope,
    maxOffsetBlocks
  );

  return {
    offsetMs: estimate.offsetSamples * blockSize * 1_000 / sampleRate,
    confidence: estimate.confidence,
  };
}
