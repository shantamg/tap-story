const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => (mockStore.has(k) ? mockStore.get(k)! : null)),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

import {
  savePendingUpload,
  listPendingUploads,
  removePendingUpload,
  PendingUpload,
} from '../pendingUploads';

const make = (tempId: string, createdAt: number): PendingUpload => ({
  tempId,
  localUri: `file:///audio/${tempId}.wav`,
  durationMs: 2000,
  startTimeMs: 0,
  parentId: null,
  createdAt,
});

describe('pendingUploads', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('persists a pending upload and lists it', async () => {
    await savePendingUpload(make('temp-1', 100));
    const list = await listPendingUploads();
    expect(list).toHaveLength(1);
    expect(list[0].tempId).toBe('temp-1');
    expect(list[0].localUri).toBe('file:///audio/temp-1.wav');
  });

  it('lists pending uploads oldest first', async () => {
    await savePendingUpload(make('temp-b', 200));
    await savePendingUpload(make('temp-a', 100));
    const list = await listPendingUploads();
    expect(list.map(r => r.tempId)).toEqual(['temp-a', 'temp-b']);
  });

  it('replaces a record with the same tempId instead of duplicating', async () => {
    await savePendingUpload(make('temp-1', 100));
    await savePendingUpload({ ...make('temp-1', 100), durationMs: 9999 });
    const list = await listPendingUploads();
    expect(list).toHaveLength(1);
    expect(list[0].durationMs).toBe(9999);
  });

  it('removes a pending upload once confirmed saved', async () => {
    await savePendingUpload(make('temp-1', 100));
    await savePendingUpload(make('temp-2', 200));
    await removePendingUpload('temp-1');
    const list = await listPendingUploads();
    expect(list.map(r => r.tempId)).toEqual(['temp-2']);
  });

  it('returns an empty list when nothing is stored or storage is corrupt', async () => {
    expect(await listPendingUploads()).toEqual([]);
    mockStore.set('tapstory_pending_uploads_v1', 'not json');
    expect(await listPendingUploads()).toEqual([]);
  });
});
