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
  duration: 10,
  parentId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    audioNode: {
      create: jest.fn().mockResolvedValue(mockAudioNode),
      findUnique: jest.fn().mockResolvedValue({
        ...mockAudioNode,
        parent: null,
      }),
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
          duration: 10,
          parentId: null
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('audioUrl');
    });

    it('should return 400 if key is missing', async () => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({ duration: 10 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Key and duration required');
    });

    it('should return 400 if duration is missing', async () => {
      const response = await request(app)
        .post('/api/audio/save')
        .send({ key: 'audio/test.webm' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Key and duration required');
    });
  });

  describe('GET /api/audio/tree/:id', () => {
    it('should return audio ancestor chain', async () => {
      const response = await request(app)
        .get('/api/audio/tree/audio-node-uuid');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ancestors');
      expect(Array.isArray(response.body.ancestors)).toBe(true);
    });
  });
});
