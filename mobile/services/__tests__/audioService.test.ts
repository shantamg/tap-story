// Mock expo-av module
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Recording: jest.fn().mockImplementation(() => ({
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      startAsync: jest.fn().mockResolvedValue(undefined),
      stopAndUnloadAsync: jest.fn().mockResolvedValue(undefined),
      getURI: jest.fn().mockReturnValue('file:///test/recording.webm'),
    })),
    AndroidOutputFormat: { WEBM: 1 },
    AndroidAudioEncoder: { DEFAULT: 0 },
    IOSOutputFormat: { MPEG4AAC: 1 },
    IOSAudioQuality: { HIGH: 127 },
  },
}));

// Mock expo-file-system
jest.mock('expo-file-system', () => ({
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1024 }),
}));

import { AudioRecorder } from '../audioService';

describe('AudioRecorder', () => {
  let recorder: AudioRecorder;

  beforeEach(() => {
    recorder = new AudioRecorder();
  });

  it('should initialize recording', async () => {
    await recorder.init();
    expect(recorder.isReady()).toBe(true);
  });

  it('should start and stop recording', async () => {
    await recorder.init();
    await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);

    const uri = await recorder.stopRecording();
    expect(uri).toBeTruthy();
    expect(recorder.isRecording()).toBe(false);
  });
});
