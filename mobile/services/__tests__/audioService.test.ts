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
