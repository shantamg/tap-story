import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * A recorded take that has been copied to durable local storage but not yet
 * confirmed saved on the server. Persisting these means a take is never lost
 * to a flaky network, a backend outage, or an app restart: the audio lives in
 * documentDirectory and the metadata needed to upload it lives here.
 */
export interface PendingUpload {
  /** Temporary client id; also the filename key of the durable local copy. */
  tempId: string;
  /** file:// URI of the durable copy in documentDirectory. */
  localUri: string;
  durationMs: number;
  startTimeMs: number;
  parentId: string | null;
  /** Epoch ms when the take was recorded, for ordering and diagnostics. */
  createdAt: number;
}

const PENDING_UPLOADS_KEY = 'tapstory_pending_uploads_v1';

async function readAll(): Promise<PendingUpload[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_UPLOADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingUpload[]) : [];
  } catch (error) {
    console.error('[pendingUploads] Failed to read pending uploads:', error);
    return [];
  }
}

async function writeAll(records: PendingUpload[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(records));
}

/** Record (or replace) a pending upload so the take survives failures/restarts. */
export async function savePendingUpload(record: PendingUpload): Promise<void> {
  const records = await readAll();
  const next = records.filter(r => r.tempId !== record.tempId);
  next.push(record);
  await writeAll(next);
}

/** List pending uploads, oldest first. */
export async function listPendingUploads(): Promise<PendingUpload[]> {
  const records = await readAll();
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

/** Remove a pending upload once its take is confirmed saved on the server. */
export async function removePendingUpload(tempId: string): Promise<void> {
  const records = await readAll();
  const next = records.filter(r => r.tempId !== tempId);
  if (next.length !== records.length) {
    await writeAll(next);
  }
}
