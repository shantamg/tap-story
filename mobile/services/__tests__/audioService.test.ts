import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { AudioRecorder, getRecordingUploadMetadata } from '../audioService';

describe('getRecordingUploadMetadata', () => {
  it.each([
    ['file:///recording.wav', { filename: 'recording.wav', contentType: 'audio/wav' }],
    ['file:///recording.m4a', { filename: 'recording.m4a', contentType: 'audio/mp4' }],
    ['file:///recording.webm', { filename: 'recording.webm', contentType: 'audio/webm' }],
  ])('uses the real container for %s', (uri, expected) => {
    expect(getRecordingUploadMetadata(uri)).toEqual(expected);
  });
});

describe('AudioRecorder', () => {
  let recorder: AudioRecorder;

  beforeEach(() => {
    jest.clearAllMocks();
    recorder = new AudioRecorder();
  });

  it('should initialize recording with simultaneous playback configuration', async () => {
    await recorder.init();

    expect(recorder.isReady()).toBe(true);
    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
  });

  it('should start and stop recording', async () => {
    await recorder.init();
    const startTimestamp = await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);
    expect(typeof startTimestamp).toBe('number');
    expect(startTimestamp).toBeGreaterThan(0);

    const result = await recorder.stopRecording();
    expect(result).toEqual({
      uri: 'file:///test/recording.m4a',
      durationMs: 1_234,
    });
    expect(recorder.isRecording()).toBe(false);
  });

  it('should measure start latency', async () => {
    await recorder.init();
    await recorder.startRecording();
    const latency = recorder.getLastStartLatency();
    expect(typeof latency).toBe('number');
    expect(latency).toBeGreaterThanOrEqual(0);
    await recorder.stopRecording();
  });

  it('should pre-prepare recording for faster start', async () => {
    await recorder.init();
    await recorder.prepareRecording();
    const startTimestamp = await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);
    expect(startTimestamp).toBeGreaterThan(0);
    await recorder.stopRecording();
  });
});
