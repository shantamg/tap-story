const callOrder: string[] = [];
let nativeInitialized = false;
let emitRecordingStarted = true;
let failRecordingFinalization = false;
let cancelBeforePunch = false;
let pendingRecordingStartedCallback: ((actualStartMs: number) => void) | undefined;
let releaseDeferredStop: (() => void) | undefined;
let deferNextStop = false;
let releaseDeferredInitialize: (() => void) | undefined;
let deferNextInitialize = false;
let failNextPlayForRouteChange = false;
let failNextPlayAndRecordForRouteChange = false;

const recordingResult = {
  uri: 'file:///recording.wav',
  startTimeMs: 1_250,
  durationMs: 2_500,
};

const mockNativeAudio = {
  isAvailable: jest.fn(() => true),
  initialize: jest.fn(async () => {
    callOrder.push('initialize');
    if (deferNextInitialize) {
      deferNextInitialize = false;
      await new Promise<void>(resolve => {
        releaseDeferredInitialize = resolve;
      });
    }
    nativeInitialized = true;
  }),
  cleanup: jest.fn(async () => {
    callOrder.push('cleanup');
    nativeInitialized = false;
  }),
  loadTracks: jest.fn(async () => {
    callOrder.push('loadTracks');
    if (!nativeInitialized) {
      throw new Error('NOT_INITIALIZED');
    }
  }),
  playAndRecord: jest.fn(async (_playFromMs: number, recordStartMs: number, callback: (actualStartMs: number) => void) => {
    callOrder.push('playAndRecord');
    if (failNextPlayAndRecordForRouteChange) {
      failNextPlayAndRecordForRouteChange = false;
      throw Object.assign(
        new Error('Audio route changed or was interrupted; reinitialize and reload tracks'),
        { code: 'PLAY_RECORD_START_ERROR' }
      );
    }
    pendingRecordingStartedCallback = callback;
    if (emitRecordingStarted) callback(recordStartMs);
  }),
  play: jest.fn(async () => {
    callOrder.push('play');
    if (failNextPlayForRouteChange) {
      failNextPlayForRouteChange = false;
      throw Object.assign(
        new Error('Audio route changed or was interrupted; reinitialize and reload tracks'),
        { code: 'PLAY_START_ERROR' }
      );
    }
  }),
  pause: jest.fn(async () => undefined),
  resume: jest.fn(async () => undefined),
  seekTo: jest.fn(async () => undefined),
  getCurrentPositionMs: jest.fn(async () => 0),
  startRecording: jest.fn(async () => {
    callOrder.push('startRecording');
  }),
  configureLatencyCompensation: jest.fn(async (customMs: number) => customMs || 28),
  configureCaptureOnlyLatencyCompensation: jest.fn(async () => {
    callOrder.push('configureCaptureOnlyLatencyCompensation');
    return 12;
  }),
  stopRecording: jest.fn(async () => {
    callOrder.push('stopRecording');
    if (failRecordingFinalization) throw new Error('CAPTURE_OVERFLOW');
    if (cancelBeforePunch) {
      throw Object.assign(new Error('No microphone frames reached the capture gate'), {
        code: 'NO_RECORDING',
      });
    }
    return recordingResult;
  }),
  stop: jest.fn(async () => {
    callOrder.push('stop');
    if (deferNextStop) {
      deferNextStop = false;
      await new Promise<void>(resolve => {
        releaseDeferredStop = resolve;
      });
    }
  }),
};

jest.mock('../TapStoryNativeAudio', () => ({
  getTapStoryAudio: () => mockNativeAudio,
}));

jest.mock('../../audioStorage', () => ({
  findCachedAudioPath: jest.fn(async () => null),
  downloadAndCacheAudio: jest.fn(async () => 'file:///cached.wav'),
}));

import { NativeDuetPlayer } from '../NativeDuetPlayer';
import { downloadAndCacheAudio } from '../../audioStorage';

describe('NativeDuetPlayer session lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    callOrder.length = 0;
    nativeInitialized = false;
    emitRecordingStarted = true;
    failRecordingFinalization = false;
    cancelBeforePunch = false;
    pendingRecordingStartedCallback = undefined;
    releaseDeferredStop = undefined;
    deferNextStop = false;
    releaseDeferredInitialize = undefined;
    deferNextInitialize = false;
    failNextPlayForRouteChange = false;
    failNextPlayAndRecordForRouteChange = false;
  });

  it('reinitializes, reloads, and retries playback once after a route change', async () => {
    const player = new NativeDuetPlayer();
    await player.loadChain([{
      id: 'segment-1',
      audioUrl: 'https://example.test/segment.wav',
      localUri: 'file:///segment.wav',
      duration: 1,
      startTime: 0,
    }]);
    failNextPlayForRouteChange = true;

    await expect(player.playFrom(0)).resolves.toBeUndefined();

    expect(mockNativeAudio.cleanup).toHaveBeenCalledTimes(1);
    expect(mockNativeAudio.initialize).toHaveBeenCalledTimes(2);
    expect(mockNativeAudio.loadTracks).toHaveBeenCalledTimes(2);
    expect(mockNativeAudio.play).toHaveBeenCalledTimes(2);
  });

  it('reinitializes, reloads, and retries an overdub start after a route change', async () => {
    const onRecordingStarted = jest.fn();
    const player = new NativeDuetPlayer();
    await player.loadChain([{
      id: 'segment-1',
      audioUrl: 'https://example.test/segment.wav',
      localUri: 'file:///segment.wav',
      duration: 1,
      startTime: 0,
    }]);
    failNextPlayAndRecordForRouteChange = true;

    await expect(player.playFrom(0, 1, onRecordingStarted)).resolves.toBeUndefined();

    expect(mockNativeAudio.cleanup).toHaveBeenCalledTimes(1);
    expect(mockNativeAudio.initialize).toHaveBeenCalledTimes(2);
    expect(mockNativeAudio.loadTracks).toHaveBeenCalledTimes(2);
    expect(mockNativeAudio.playAndRecord).toHaveBeenCalledTimes(2);
    expect(onRecordingStarted).toHaveBeenCalledTimes(1);
  });

  it('keeps the take finalizable after stopping the playback transport', async () => {
    const player = new NativeDuetPlayer();
    await player.initialize();
    await player.playFrom(0, 1.25, () => undefined);

    const result = await player.stop();

    expect(result).toEqual(recordingResult);
    expect(callOrder.slice(-2)).toEqual(['stop', 'stopRecording']);
  });

  it('finalizes an armed take when stopped before the punch callback', async () => {
    emitRecordingStarted = false;
    cancelBeforePunch = true;
    const player = new NativeDuetPlayer();
    await player.initialize();
    await player.playFrom(0, 5, () => undefined);

    const result = await player.stop();

    expect(result).toBeNull();
    expect(callOrder.slice(-2)).toEqual(['stop', 'stopRecording']);
    expect(mockNativeAudio.cleanup).not.toHaveBeenCalled();
  });

  it('rebuilds the native engine after a failed take finalization', async () => {
    failRecordingFinalization = true;
    const player = new NativeDuetPlayer();
    await player.initialize();
    await player.playFrom(0, 1, () => undefined);

    await expect(player.stop()).rejects.toThrow('CAPTURE_OVERFLOW');

    expect(callOrder.slice(-3)).toEqual(['stop', 'stopRecording', 'cleanup']);
    expect(nativeInitialized).toBe(false);
  });

  it('reinitializes the native engine after cleanup before loading tracks', async () => {
    const player = new NativeDuetPlayer();
    await player.initialize();
    await player.cleanup();

    await expect(player.loadChain([{
      id: 'segment-1',
      audioUrl: 'https://example.test/segment.wav',
      localUri: 'file:///segment.wav',
      duration: 1,
      startTime: 0,
    }])).resolves.toBeUndefined();

    expect(callOrder.slice(-2)).toEqual(['initialize', 'loadTracks']);
  });

  it('configures capture latency before an overdub session', async () => {
    const player = new NativeDuetPlayer();

    await expect(player.configureLatencyCompensation(37)).resolves.toBe(37);

    expect(mockNativeAudio.configureLatencyCompensation).toHaveBeenCalledWith(37);
  });

  it('uses input-only latency compensation before a standalone first take', async () => {
    emitRecordingStarted = false;
    const player = new NativeDuetPlayer();

    try {
      let resolved = false;
      const startPromise = player.startRecordingOnly().then(() => {
        resolved = true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(resolved).toBe(false);
      expect(pendingRecordingStartedCallback).toBeDefined();
      pendingRecordingStartedCallback?.(12);
      await startPromise;

      expect(callOrder).toContain('configureCaptureOnlyLatencyCompensation');
      expect(mockNativeAudio.configureCaptureOnlyLatencyCompensation)
        .toHaveBeenCalledTimes(1);
      expect(mockNativeAudio.playAndRecord).toHaveBeenCalledWith(
        0,
        0,
        expect.any(Function)
      );
      expect(mockNativeAudio.startRecording).not.toHaveBeenCalled();
      expect(callOrder.slice(-3)).toEqual([
        'loadTracks',
        'configureCaptureOnlyLatencyCompensation',
        'playAndRecord',
      ]);
    } finally {
      await player.stop();
    }
  });

  it('clears native tracks when loading an empty story', async () => {
    const player = new NativeDuetPlayer();
    await player.initialize();

    await player.loadChain([]);

    expect(mockNativeAudio.loadTracks).toHaveBeenLastCalledWith([]);
  });

  it('never passes a failed remote download to the local native decoder', async () => {
    (downloadAndCacheAudio as jest.Mock).mockRejectedValueOnce(
      new Error('Audio segment temp-1 has no downloadable URL')
    );
    const player = new NativeDuetPlayer();

    await expect(player.loadChain([{
      id: 'temp-1',
      audioUrl: '',
      duration: 5.96,
      startTime: 0,
    }])).rejects.toThrow('Failed to prepare audio segment temp-1');

    expect(mockNativeAudio.loadTracks).not.toHaveBeenCalled();
  });

  it('does not let an in-flight playFrom overtake stop', async () => {
    const player = new NativeDuetPlayer();
    await player.initialize();
    deferNextStop = true;

    const playPromise = player.playFrom(0);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releaseDeferredStop).toBeDefined();

    await player.stop();
    releaseDeferredStop?.();

    await expect(playPromise).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(mockNativeAudio.play).not.toHaveBeenCalled();
    await expect(player.getPlaybackState()).resolves.toBe('stopped');
  });

  it('cancels playFrom while initialization is still in flight', async () => {
    deferNextInitialize = true;
    cancelBeforePunch = true;
    const player = new NativeDuetPlayer();

    const playPromise = player.playFrom(0, 5, jest.fn());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releaseDeferredInitialize).toBeDefined();

    let stopSettled = false;
    const stopPromise = player.stop().then(result => {
      stopSettled = true;
      return result;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopSettled).toBe(false);
    releaseDeferredInitialize?.();

    await expect(stopPromise).resolves.toBeNull();
    await expect(playPromise).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(mockNativeAudio.play).not.toHaveBeenCalled();
    expect(mockNativeAudio.playAndRecord).not.toHaveBeenCalled();
    await expect(player.getPlaybackState()).resolves.toBe('stopped');

    cancelBeforePunch = false;
    await player.loadChain([{
      id: 'post-init-cancel-segment',
      audioUrl: 'https://example.test/post-init-cancel.wav',
      localUri: 'file:///post-init-cancel.wav',
      duration: 10,
      startTime: 0,
    }]);
    await player.playFrom(0);

    expect(mockNativeAudio.initialize).toHaveBeenCalledTimes(1);
    expect(mockNativeAudio.play).toHaveBeenCalledTimes(1);
    expect(mockNativeAudio.cleanup).not.toHaveBeenCalled();
    await player.stop();
  });

  it('cancels a first-frame waiter without letting its timeout clean up a newer session', async () => {
    jest.useFakeTimers();
    emitRecordingStarted = false;
    cancelBeforePunch = true;
    const player = new NativeDuetPlayer();

    try {
      const firstTakePromise = player.startRecordingOnly();
      const cancelledFirstTake = firstTakePromise.catch(error => error);
      await Promise.resolve();
      await Promise.resolve();

      await expect(player.stop()).resolves.toBeNull();
      await expect(cancelledFirstTake).resolves.toMatchObject({
        code: 'SESSION_CANCELLED',
      });

      cancelBeforePunch = false;
      await player.loadChain([{
        id: 'new-session-segment',
        audioUrl: 'https://example.test/new-session.wav',
        localUri: 'file:///new-session.wav',
        duration: 10,
        startTime: 0,
      }]);
      await player.playFrom(0);

      await jest.advanceTimersByTimeAsync(5_001);

      expect(mockNativeAudio.cleanup).not.toHaveBeenCalled();
      await expect(player.getPlaybackState()).resolves.toBe('playing');
    } finally {
      await player.stop();
      jest.useRealTimers();
    }
  });

  it('ignores a queued recording-onset callback after stop', async () => {
    emitRecordingStarted = false;
    cancelBeforePunch = true;
    const onRecordingStarted = jest.fn();
    const player = new NativeDuetPlayer();
    await player.initialize();
    await player.playFrom(0, 5, onRecordingStarted);
    const queuedOnset = pendingRecordingStartedCallback;

    await expect(player.stop()).resolves.toBeNull();
    queuedOnset?.(5_000);

    expect(onRecordingStarted).not.toHaveBeenCalled();
    await expect(player.getPlaybackState()).resolves.toBe('stopped');
    expect(player.getRecordingStartPosition()).toBe(0);
  });
});
