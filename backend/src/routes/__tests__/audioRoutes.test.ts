// Mock uuid module
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234'
}));

// Set up test AWS credentials before importing modules
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_S3_BUCKET = 'tapstory-audio-dev';

// Mock Prisma
const mockAudioNode = {
  id: 'audio-node-uuid',
  audioUrl: 'audio/test-uuid-1234-recording.webm',
  durationMs: 10_123,
  startTimeMs: 0,
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCreate = jest.fn().mockResolvedValue(mockAudioNode);
const mockFindUnique = jest.fn().mockResolvedValue({
  ...mockAudioNode,
  parent: null,
});
const mockFindMany = jest.fn().mockResolvedValue([]);
const mockDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
const mockTransaction = jest.fn();
const mockMeasureLatencyMsForKeys = jest.fn().mockResolvedValue(42);
const mockDeleteAudioFile = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/latencyCalibration', () => ({
  measureLatencyMsForKeys: mockMeasureLatencyMsForKeys,
}));

jest.mock('../../services/s3Service', () => {
  const actual = jest.requireActual('../../services/s3Service');
  return {
    ...actual,
    deleteAudioFile: mockDeleteAudioFile,
  };
});

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $transaction: mockTransaction,
    audioNode: {
      create: mockCreate,
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      deleteMany: mockDeleteMany,
    },
  })),
}));

import request from 'supertest';
import express from 'express';
import audioRoutes from '../audioRoutes';

const app = express();
app.use(express.json());
app.use('/api/audio', audioRoutes);

describe('Audio Routes', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockFindUnique.mockReset();
    mockFindUnique.mockResolvedValue({
      ...mockAudioNode,
      parent: null,
    });
    mockFindMany.mockReset();
    mockFindMany.mockResolvedValue([]);
    mockDeleteMany.mockReset();
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async callback => callback({
      audioNode: {
        findUnique: mockFindUnique,
        deleteMany: mockDeleteMany,
      },
    }));
    mockDeleteAudioFile.mockReset();
    mockDeleteAudioFile.mockResolvedValue(undefined);
    mockMeasureLatencyMsForKeys.mockReset();
    mockMeasureLatencyMsForKeys.mockResolvedValue(42);
  });

  describe('POST /api/audio/upload-url', () => {
    it('should return presigned upload URL', async () => {
      const response = await request(app)
        .post('/api/audio/upload-url')
        .send({ filename: 'recording.webm' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('uploadUrl');
      expect(response.body).toHaveProperty('key');
      expect(response.body.uploadUrl).toContain('https://');
    });

    it('should return 400 if filename is missing', async () => {
      const response = await request(app)
        .post('/api/audio/upload-url')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Filename required');
    });
  });

  describe('POST /api/audio/save', () => {
    it('should save audio node to database', async () => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({
          key: 'audio/test.webm',
          durationMs: 10_123,
          parentId: null
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('audioUrl');
      expect(response.body.durationMs).toBe(10_123);
      expect(response.body.startTimeMs).toBe(0);
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          audioUrl: 'audio/test.webm',
          durationMs: 10_123,
          startTimeMs: 0,
          parentId: null,
        },
      });
    });

    it('should return 400 if key is missing', async () => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({ durationMs: 10_123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Key and durationMs required');
    });

    it('should return 400 if durationMs is missing', async () => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({ key: 'audio/test.webm' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Key and durationMs required');
    });

    it('should derive a direct reply start at zero', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: 'parent', parent: null });

      const response = await request(app)
        .post('/api/audio/save')
        .send({ key: 'audio/test.webm', durationMs: 10_123, parentId: 'parent' });

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          audioUrl: 'audio/test.webm',
          durationMs: 10_123,
          startTimeMs: 0,
          parentId: 'parent',
        },
      });
    });

    it('should derive a deeper reply from the grandparent end', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: 'parent',
        parent: { durationMs: 10_001, startTimeMs: 2_345 },
      });

      const response = await request(app)
        .post('/api/audio/save')
        .send({ key: 'audio/test.webm', durationMs: 4_321, parentId: 'parent' });

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          audioUrl: 'audio/test.webm',
          durationMs: 4_321,
          startTimeMs: 12_346,
          parentId: 'parent',
        },
      });
    });

    it('should reject a reply to a missing parent', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      const response = await request(app)
        .post('/api/audio/save')
        .send({ key: 'audio/test.webm', durationMs: 4_321, parentId: 'missing' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Parent audio node not found');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([
      { durationMs: 0 },
      { durationMs: 10.5 },
    ])('should reject non-integer or out-of-range duration metadata: %p', async payload => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({ key: 'audio/test.webm', ...payload });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe(
        'durationMs must be a positive integer'
      );
    });
  });

  describe('GET /api/audio/chains', () => {
    it('returns persisted exact timeline metadata without recalculating it', async () => {
      const createdAt = new Date('2026-07-12T12:00:00.000Z');
      mockFindMany.mockResolvedValue([
        {
          id: 'node-4',
          audioUrl: 'audio/4.wav',
          durationMs: 30_000,
          startTimeMs: 5_000,
          parentId: 'node-3',
          createdAt,
          updatedAt: createdAt,
        },
      ]);
      const nodes = new Map([
        ['node-4', { id: 'node-4', durationMs: 30_000, startTimeMs: 5_000, parentId: 'node-3' }],
        ['node-3', { id: 'node-3', durationMs: 1_000, startTimeMs: 20_000, parentId: 'node-2' }],
        ['node-2', { id: 'node-2', durationMs: 5_000, startTimeMs: 0, parentId: 'node-1' }],
        ['node-1', { id: 'node-1', durationMs: 20_000, startTimeMs: 0, parentId: null }],
      ]);
      mockFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(nodes.get(where.id) ?? null)
      );

      const response = await request(app).get('/api/audio/chains');

      expect(response.status).toBe(200);
      expect(response.body.chains[0]).toMatchObject({
        id: 'node-4',
        chainLength: 4,
        totalDurationMs: 35_000,
        segments: [
          { id: 'node-1', durationMs: 20_000, startTimeMs: 0, parentId: null },
          { id: 'node-2', durationMs: 5_000, startTimeMs: 0, parentId: 'node-1' },
          { id: 'node-3', durationMs: 1_000, startTimeMs: 20_000, parentId: 'node-2' },
          { id: 'node-4', durationMs: 30_000, startTimeMs: 5_000, parentId: 'node-3' },
        ],
      });
    });
  });

  describe('GET /api/audio/tree/:id', () => {
    it('should return audio ancestor chain', async () => {
      const response = await request(app)
        .get('/api/audio/tree/audio-node-uuid');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ancestors');
      expect(Array.isArray(response.body.ancestors)).toBe(true);
      expect(response.body.ancestors[0]).toMatchObject({
        durationMs: 10_123,
        startTimeMs: 0,
      });
    });
  });

  describe('POST /api/audio/calibrate', () => {
    it('converts local waveform delay into an absolute timeline offset', async () => {
      mockFindUnique
        .mockResolvedValueOnce({
          id: 'reference',
          audioUrl: 'audio/reference.wav',
          startTimeMs: 1_000,
        })
        .mockResolvedValueOnce({
          id: 'test',
          audioUrl: 'audio/test.wav',
          startTimeMs: 1_250,
        });
      mockMeasureLatencyMsForKeys.mockResolvedValue(30);

      const response = await request(app)
        .post('/api/audio/calibrate')
        .send({ referenceNodeId: 'reference', testNodeId: 'test' });

      expect(response.status).toBe(200);
      expect(response.body.offsetMs).toBe(280);
    });
  });

  describe('DELETE /api/audio/chain/:id', () => {
    it('deletes only the exclusive suffix when an ancestor is shared', async () => {
      const nodes = new Map([
        ['leaf-a', {
          id: 'leaf-a',
          audioUrl: 'audio/leaf-a.wav',
          parentId: 'shared',
          _count: { children: 0 },
        }],
        ['shared', {
          id: 'shared',
          audioUrl: 'audio/shared.wav',
          parentId: 'root',
          _count: { children: 2 },
        }],
      ]);
      mockFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(nodes.get(where.id) ?? null)
      );
      mockDeleteMany.mockResolvedValue({ count: 1 });

      const response = await request(app).delete('/api/audio/chain/leaf-a');

      expect(response.status).toBe(200);
      expect(response.body.nodeIds).toEqual(['leaf-a']);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockTransaction.mock.calls[0][1]).toEqual({
        isolationLevel: 'Serializable',
      });
      expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['leaf-a'] } } });
      expect(mockDeleteAudioFile).toHaveBeenCalledTimes(1);
      expect(mockDeleteAudioFile).toHaveBeenCalledWith('audio/leaf-a.wav');
    });

    it('rejects deleting a non-leaf as though it were one story', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: 'branch',
        audioUrl: 'audio/branch.wav',
        parentId: 'root',
        _count: { children: 1 },
      });

      const response = await request(app).delete('/api/audio/chain/branch');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Only a leaf story can be deleted');
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it('retries the whole deletion plan after a serializable write conflict', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: 'leaf-a',
        audioUrl: 'audio/leaf-a.wav',
        parentId: null,
        _count: { children: 0 },
      });
      mockDeleteMany.mockResolvedValue({ count: 1 });
      mockTransaction.mockRejectedValueOnce(
        Object.assign(new Error('write conflict'), { code: 'P2034' })
      );

      const response = await request(app).delete('/api/audio/chain/leaf-a');

      expect(response.status).toBe(200);
      expect(mockTransaction).toHaveBeenCalledTimes(2);
      expect(mockDeleteAudioFile).toHaveBeenCalledWith('audio/leaf-a.wav');
    });
  });
});
