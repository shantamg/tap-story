import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  downloadAndCacheAudio,
  findCachedAudioPath,
  getLocalAudioPath,
  getLatencyOffset,
  saveRecordingLocally,
} from '../audioStorage';

const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;

describe('audioStorage format-safe cache paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      isDirectory: true,
      uri: 'file:///documents/audio/',
      size: 0,
      modificationTime: 0,
    });
    mockedFileSystem.readDirectoryAsync.mockResolvedValue([]);
  });

  it('preserves the actual recording container extension', () => {
    expect(getLocalAudioPath('node-1', 'file:///cache/recording.wav')).toBe(
      'file:///documents/audio/node-1.wav'
    );
    expect(getLocalAudioPath(
      'node-2',
      'https://bucket.example/audio/recording.m4a?X-Amz-Signature=test'
    )).toBe('file:///documents/audio/node-2.m4a');
  });

  it('finds cached audio independently of its codec extension', async () => {
    mockedFileSystem.readDirectoryAsync.mockResolvedValue([
      'unrelated.wav',
      'node-1.wav',
    ]);

    await expect(findCachedAudioPath('node-1')).resolves.toBe(
      'file:///documents/audio/node-1.wav'
    );
  });

  it('copies a native WAV recording to a WAV cache path', async () => {
    const result = await saveRecordingLocally(
      'file:///cache/native-recording.wav',
      'node-1'
    );

    expect(result).toBe('file:///documents/audio/node-1.wav');
    expect(mockedFileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'file:///cache/native-recording.wav',
      to: 'file:///documents/audio/node-1.wav',
    });
  });

  it('downloads atomically using the remote container extension', async () => {
    const remoteUrl = 'https://bucket.example/audio/node.webm?signature=test';

    await expect(downloadAndCacheAudio(remoteUrl, 'node-1')).resolves.toBe(
      'file:///documents/audio/node-1.webm'
    );
    expect(mockedFileSystem.downloadAsync).toHaveBeenCalledWith(
      remoteUrl,
      'file:///documents/audio/node-1.webm.download'
    );
    expect(mockedFileSystem.moveAsync).toHaveBeenCalledWith({
      from: 'file:///documents/audio/node-1.webm.download',
      to: 'file:///documents/audio/node-1.webm',
    });
  });

  it('rejects a pending segment with no remote URL before invoking the downloader', async () => {
    await expect(downloadAndCacheAudio('', 'temp-1')).rejects.toThrow(
      'Audio segment temp-1 has no downloadable URL'
    );
    expect(mockedFileSystem.downloadAsync).not.toHaveBeenCalled();
  });

  it('falls back to automatic latency when persisted calibration is invalid', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-a-number');
    await expect(getLatencyOffset()).resolves.toBe(0);
  });

  it('preserves a signed fine-tune adjustment around automatic route latency', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('-12');
    await expect(getLatencyOffset()).resolves.toBe(-12);
  });
});
