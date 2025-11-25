import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateDownloadUrl } from '../services/s3Service';

/**
 * Decode an audio file from S3 (by key) to a local mono 16-bit PCM WAV file.
 * Returns the path to the WAV file.
 */
async function decodeToWavTempFile(key: string): Promise<string> {
  const downloadUrl = await generateDownloadUrl(key);
  const tmpDir = os.tmpdir();
  const wavPath = path.join(tmpDir, `tapstory-latency-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(downloadUrl)
      .audioChannels(1)
      .audioFrequency(44100)
      .format('wav')
      .output(wavPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });

  return wavPath;
}

interface PcmData {
  samples: Int16Array;
  sampleRate: number;
}

/**
 * Very small WAV reader for PCM 16-bit mono files.
 * Assumes standard RIFF/WAVE format as produced by ffmpeg above.
 */
function readPcmFromWav(wavPath: string): PcmData {
  const buffer = fs.readFileSync(wavPath);

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Unsupported WAV format');
  }

  const fmtIndex = buffer.indexOf('fmt ');
  if (fmtIndex === -1) {
    throw new Error('WAV fmt chunk not found');
  }

  const audioFormat = buffer.readUInt16LE(fmtIndex + 8);
  const numChannels = buffer.readUInt16LE(fmtIndex + 10);
  const sampleRate = buffer.readUInt32LE(fmtIndex + 12);
  const bitsPerSample = buffer.readUInt16LE(fmtIndex + 22);

  if (audioFormat !== 1 || numChannels !== 1 || bitsPerSample !== 16) {
    throw new Error('Expected 16-bit PCM mono WAV');
  }

  const dataIndex = buffer.indexOf('data', fmtIndex);
  if (dataIndex === -1) {
    throw new Error('WAV data chunk not found');
  }

  const dataSize = buffer.readUInt32LE(dataIndex + 4);
  const dataStart = dataIndex + 8;
  const dataEnd = dataStart + dataSize;
  const pcmBuffer = buffer.slice(dataStart, dataEnd);

  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );

  return { samples, sampleRate };
}

/**
 * Find the first major transient (e.g., a click) in the PCM samples.
 * Returns the sample index of the transient.
 */
function findClickSampleIndex(samples: Int16Array): number {
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = Math.abs(samples[i]);
    if (val > maxAbs) maxAbs = val;
  }

  if (maxAbs === 0) {
    return 0;
  }

  const threshold = maxAbs * 0.6; // 60% of max amplitude

  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) {
      return i;
    }
  }

  return 0;
}

/**
 * Measure latency between a reference audio file and a test recording.
 * Both are identified by their S3 keys.
 *
 * Assumes both contain the same transient (click) and measures the
 * time difference between the first strong transient in each.
 *
 * Returns latency in milliseconds: test - reference.
 */
export async function measureLatencyMsForKeys(
  referenceKey: string,
  testKey: string
): Promise<number> {
  // Decode both files to local WAV
  const refWav = await decodeToWavTempFile(referenceKey);
  const testWav = await decodeToWavTempFile(testKey);

  try {
    const refPcm = readPcmFromWav(refWav);
    const testPcm = readPcmFromWav(testWav);

    if (refPcm.sampleRate !== testPcm.sampleRate) {
      throw new Error('Sample rates do not match in calibration files');
    }

    const refIndex = findClickSampleIndex(refPcm.samples);
    const testIndex = findClickSampleIndex(testPcm.samples);

    const diffSamples = testIndex - refIndex;
    const diffSeconds = diffSamples / refPcm.sampleRate;
    const diffMs = diffSeconds * 1000;

    return diffMs;
  } finally {
    // Clean up temp files
    try {
      fs.unlinkSync(refWav);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(testWav);
    } catch {
      // ignore
    }
  }
}


