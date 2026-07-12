import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUDIO_DIRECTORY = `${FileSystem.documentDirectory}audio/`;
const LATENCY_KEY = 'tapstory_latency_adjustment_ms_v2';
const MAX_LATENCY_ADJUSTMENT_MS = 250;

/**
 * Save the signed fine-tune applied around automatic route latency.
 */
export async function saveLatencyOffset(offsetMs: number): Promise<void> {
  try {
    const bounded = Number.isFinite(offsetMs)
      ? Math.max(-MAX_LATENCY_ADJUSTMENT_MS, Math.min(MAX_LATENCY_ADJUSTMENT_MS, offsetMs))
      : 0;
    await AsyncStorage.setItem(LATENCY_KEY, bounded.toString());
  } catch (e) {
    console.error('Failed to save latency offset:', e);
  }
}

/**
 * Get the signed fine-tune applied around automatic route latency.
 */
export async function getLatencyOffset(): Promise<number> {
  try {
    const value = await AsyncStorage.getItem(LATENCY_KEY);
    if (!value) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed)
      && parsed >= -MAX_LATENCY_ADJUSTMENT_MS
      && parsed <= MAX_LATENCY_ADJUSTMENT_MS
      ? parsed
      : 0;
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
export function getLocalAudioPath(nodeId: string, sourceUri?: string): string {
  const extension = getAudioExtension(sourceUri)
    ?? (Platform.OS === 'ios' ? 'm4a' : 'webm');
  return `${AUDIO_DIRECTORY}${nodeId}.${extension}`;
}

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  'aac',
  'caf',
  'flac',
  'm4a',
  'mp3',
  'mp4',
  'ogg',
  'wav',
  'webm',
]);

function getAudioExtension(uri?: string): string | null {
  if (!uri) return null;

  const path = uri.split(/[?#]/, 1)[0];
  const match = path.match(/\.([a-z0-9]+)$/i);
  if (!match) return null;

  const extension = match[1].toLowerCase();
  return SUPPORTED_AUDIO_EXTENSIONS.has(extension) ? extension : null;
}

/** Find an existing cache entry without assuming its codec/container. */
export async function findCachedAudioPath(nodeId: string): Promise<string | null> {
  const directoryInfo = await FileSystem.getInfoAsync(AUDIO_DIRECTORY);
  if (!directoryInfo.exists) return null;

  const prefix = `${nodeId}.`;
  const files = await FileSystem.readDirectoryAsync(AUDIO_DIRECTORY);
  const filename = files.find(file => file.startsWith(prefix) && !file.endsWith('.download'));
  return filename ? `${AUDIO_DIRECTORY}${filename}` : null;
}

/**
 * Check if a local audio file exists
 */
export async function localAudioExists(nodeId: string): Promise<boolean> {
  return (await findCachedAudioPath(nodeId)) !== null;
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

  const localPath = getLocalAudioPath(nodeId, tempUri);

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

  const cachedPath = await findCachedAudioPath(nodeId);
  if (cachedPath) {
    return cachedPath;
  }

  const normalizedRemoteUrl = remoteUrl.trim();
  if (!normalizedRemoteUrl) {
    throw new Error(`Audio segment ${nodeId} has no downloadable URL`);
  }
  if (!/^https?:\/\//i.test(normalizedRemoteUrl)) {
    throw new Error(`Audio segment ${nodeId} has an unsupported download URL`);
  }

  const localPath = getLocalAudioPath(nodeId, normalizedRemoteUrl);
  const temporaryPath = `${localPath}.download`;

  // Download to a temporary path so interrupted downloads are never treated as
  // playable cache entries.
  await FileSystem.deleteAsync(temporaryPath, { idempotent: true });
  const downloadResult = await FileSystem.downloadAsync(normalizedRemoteUrl, temporaryPath);

  if (downloadResult.status !== 200) {
    await FileSystem.deleteAsync(temporaryPath, { idempotent: true });
    throw new Error(`Failed to download audio: ${downloadResult.status}`);
  }

  await FileSystem.moveAsync({ from: temporaryPath, to: localPath });

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
  const cachedPath = await findCachedAudioPath(nodeId);

  if (cachedPath) {
    return { uri: cachedPath, isLocal: true };
  }

  return { uri: remoteUrl, isLocal: false };
}

/**
 * Delete a local audio file
 */
export async function deleteLocalAudio(nodeId: string): Promise<void> {
  const directoryInfo = await FileSystem.getInfoAsync(AUDIO_DIRECTORY);
  if (!directoryInfo.exists) return;

  const prefix = `${nodeId}.`;
  const files = await FileSystem.readDirectoryAsync(AUDIO_DIRECTORY);
  for (const file of files.filter(filename => filename.startsWith(prefix))) {
    await FileSystem.deleteAsync(`${AUDIO_DIRECTORY}${file}`, { idempotent: true });
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
