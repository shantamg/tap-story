import {
  isValidUploadFilename,
  isValidUploadContentType,
  isValidAudioKey,
} from '../audioUploadValidation';

describe('isValidUploadFilename', () => {
  it('accepts a plain audio basename', () => {
    expect(isValidUploadFilename('recording.wav')).toBe(true);
    expect(isValidUploadFilename('take-2_final.m4a')).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    expect(isValidUploadFilename('../../etc/passwd')).toBe(false);
    expect(isValidUploadFilename('audio/evil.wav')).toBe(false);
    expect(isValidUploadFilename('a\\b.wav')).toBe(false);
    expect(isValidUploadFilename('nul\0.wav')).toBe(false);
  });

  it('rejects disallowed or missing extensions', () => {
    expect(isValidUploadFilename('recording.exe')).toBe(false);
    expect(isValidUploadFilename('recording')).toBe(false);
  });

  it('rejects non-strings and over-long names', () => {
    expect(isValidUploadFilename(undefined)).toBe(false);
    expect(isValidUploadFilename(123)).toBe(false);
    expect(isValidUploadFilename('a'.repeat(200) + '.wav')).toBe(false);
  });
});

describe('isValidUploadContentType', () => {
  it('accepts known audio types and an omitted type', () => {
    expect(isValidUploadContentType('audio/wav')).toBe(true);
    expect(isValidUploadContentType('audio/webm')).toBe(true);
    expect(isValidUploadContentType(undefined)).toBe(true);
  });

  it('rejects arbitrary or non-audio types', () => {
    expect(isValidUploadContentType('text/html')).toBe(false);
    expect(isValidUploadContentType('application/octet-stream')).toBe(false);
    expect(isValidUploadContentType(42)).toBe(false);
  });
});

describe('isValidAudioKey', () => {
  it('accepts a service-minted key', () => {
    expect(isValidAudioKey('audio/3f2504e0-4f89-41d3-9a0c-0305e82c3301-recording.wav')).toBe(true);
  });

  it('rejects arbitrary or traversal keys', () => {
    expect(isValidAudioKey('audio/anything.wav')).toBe(false);
    expect(isValidAudioKey('../secret')).toBe(false);
    expect(isValidAudioKey('audio/3f2504e0-4f89-41d3-9a0c-0305e82c3301-../x.wav')).toBe(false);
    expect(isValidAudioKey(undefined)).toBe(false);
  });
});
