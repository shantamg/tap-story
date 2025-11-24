// Mock uuid module
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234'
}));

// Set up test AWS credentials
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_S3_BUCKET = 'tapstory-audio-dev';

import { generateUploadUrl, generateDownloadUrl } from '../s3Service';

describe('S3Service', () => {
  it('should generate a presigned upload URL', async () => {
    const result = await generateUploadUrl('test.webm');

    expect(result.uploadUrl).toContain('https://');
    expect(result.uploadUrl).toContain('tapstory-audio-dev');
    expect(result.key).toContain('audio/');
  });

  it('should generate a presigned download URL', async () => {
    const url = await generateDownloadUrl('audio/test.webm');

    expect(url).toContain('https://');
    expect(url).toContain('tapstory-audio-dev');
  });
});
