import { validateAudioFormat, validateAudioDuration, validateAudioBuffer } from '../audioValidation';
import { AudioFormat } from '../../types/audio';

describe('audioValidation', () => {
  describe('validateAudioFormat', () => {
    it('should validate allowed audio formats', () => {
      const result = validateAudioFormat('mp3');
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject invalid audio formats', () => {
      const result = validateAudioFormat('invalid');
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('Invalid audio format');
    });
  });

  describe('validateAudioDuration', () => {
    it('should validate audio duration within allowed range', () => {
      const result = validateAudioDuration(60);
      expect(result.valid).toBe(true);
    });

    it('should reject negative duration', () => {
      const result = validateAudioDuration(-1);
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toContain('must be greater than 0');
    });

    it('should reject duration exceeding maximum', () => {
      const result = validateAudioDuration(400);
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toContain('exceeds maximum');
    });
  });

  describe('validateAudioBuffer', () => {
    it('should validate non-empty buffer', () => {
      const buffer = Buffer.from('test audio data');
      const result = validateAudioBuffer(buffer);
      expect(result.valid).toBe(true);
    });

    it('should reject empty buffer', () => {
      const buffer = Buffer.from('');
      const result = validateAudioBuffer(buffer);
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toContain('empty');
    });
  });
});
