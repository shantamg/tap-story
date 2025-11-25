import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUDIO_DIRECTORY = `${FileSystem.documentDirectory}audio/`;
const LATENCY_KEY = 'tapstory_latency_offset_ms';

/**
 * Save global latency offset
 */
export async function saveLatencyOffset(offsetMs: number): Promise<void> {
  try {
    await AsyncStorage.setItem(LATENCY_KEY, offsetMs.toString());
  } catch (e) {
    console.error('Failed to save latency offset:', e);
  }
}

/**
 * Get global latency offset
 */
export async function getLatencyOffset(): Promise<number> {
  try {
    const value = await AsyncStorage.getItem(LATENCY_KEY);
    return value ? parseInt(value, 10) : 0;
  } catch (e) {
    console.error('Failed to get latency offset:', e);
    return 0;
  }
}

/**
 * Ensures the audio directory exists
 */
async function ensureDirectoryExists(): Promise<void> {
  const info = await FileSystem.getInfoAsync(AUDIO_DIRECTORY);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(AUDIO_DIRECTORY, { intermediates: true });
  }
}

/**
 * Get the local file path for an audio node
 */
export function getLocalAudioPath(nodeId: string): string {
  const extension = Platform.OS === 'ios' ? 'm4a' : 'webm';
  return `${AUDIO_DIRECTORY}${nodeId}.${extension}`;
}

/**
 * Check if a local audio file exists
 */
export async function localAudioExists(nodeId: string): Promise<boolean> {
  const path = getLocalAudioPath(nodeId);
  const info = await FileSystem.getInfoAsync(path);
  return info.exists;
}

/**
 * Save a recording to permanent local storage
 * @param tempUri - The temporary URI from the recording
 * @param nodeId - The audio node ID to use as filename
 * @returns The permanent local URI
 */
export async function saveRecordingLocally(
  tempUri: string,
  nodeId: string
): Promise<string> {
  await ensureDirectoryExists();

  const localPath = getLocalAudioPath(nodeId);

  // Copy from temp location to permanent storage
  await FileSystem.copyAsync({
    from: tempUri,
    to: localPath,
  });

  return localPath;
}

/**
 * Download audio from a remote URL and save locally
 * @param remoteUrl - The presigned S3 URL
 * @param nodeId - The audio node ID
 * @returns The local file URI
 */
export async function downloadAndCacheAudio(
  remoteUrl: string,
  nodeId: string
): Promise<string> {
  await ensureDirectoryExists();

  const localPath = getLocalAudioPath(nodeId);

  // Check if already cached
  const exists = await localAudioExists(nodeId);
  if (exists) {
    return localPath;
  }

  // Download to local storage
  const downloadResult = await FileSystem.downloadAsync(remoteUrl, localPath);

  if (downloadResult.status !== 200) {
    throw new Error(`Failed to download audio: ${downloadResult.status}`);
  }

  return localPath;
}

/**
 * Get the URI to use for playback - local if available, otherwise remote
 * @param nodeId - The audio node ID
 * @param remoteUrl - The fallback remote URL
 * @returns Object with uri and whether it's local
 */
export async function getPlaybackUri(
  nodeId: string,
  remoteUrl: string
): Promise<{ uri: string; isLocal: boolean }> {
  const exists = await localAudioExists(nodeId);

  if (exists) {
    return { uri: getLocalAudioPath(nodeId), isLocal: true };
  }

  return { uri: remoteUrl, isLocal: false };
}

/**
 * Delete a local audio file
 */
export async function deleteLocalAudio(nodeId: string): Promise<void> {
  const path = getLocalAudioPath(nodeId);
  const info = await FileSystem.getInfoAsync(path);

  if (info.exists) {
    await FileSystem.deleteAsync(path, { idempotent: true });
  }
}

/**
 * Delete all local audio files
 */
export async function clearAllLocalAudio(): Promise<void> {
  const info = await FileSystem.getInfoAsync(AUDIO_DIRECTORY);

  if (info.exists) {
    await FileSystem.deleteAsync(AUDIO_DIRECTORY, { idempotent: true });
  }
}

/**
 * Get total size of cached audio files in bytes
 */
export async function getLocalAudioCacheSize(): Promise<number> {
  const info = await FileSystem.getInfoAsync(AUDIO_DIRECTORY);

  if (!info.exists) {
    return 0;
  }

  const files = await FileSystem.readDirectoryAsync(AUDIO_DIRECTORY);
  let totalSize = 0;

  for (const file of files) {
    const fileInfo = await FileSystem.getInfoAsync(`${AUDIO_DIRECTORY}${file}`);
    if (fileInfo.exists && 'size' in fileInfo) {
      totalSize += fileInfo.size || 0;
    }
  }

  return totalSize;
}
