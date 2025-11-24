import { AudioFormat, ValidationResult } from '../types/audio';
import { MAX_AUDIO_DURATION_SECONDS, ALLOWED_AUDIO_FORMATS } from '../constants/audio';

export function validateAudioFormat(format: string): ValidationResult {
  const normalizedFormat = format.toLowerCase();

  if (!ALLOWED_AUDIO_FORMATS.includes(normalizedFormat as AudioFormat)) {
    return {
      valid: false,
      errors: [`Invalid audio format: ${format}. Allowed formats: ${ALLOWED_AUDIO_FORMATS.join(', ')}`],
    };
  }

  return { valid: true };
}

export function validateAudioDuration(duration: number): ValidationResult {
  if (duration <= 0) {
    return {
      valid: false,
      errors: ['Audio duration must be greater than 0'],
    };
  }

  if (duration > MAX_AUDIO_DURATION_SECONDS) {
    return {
      valid: false,
      errors: [`Audio duration exceeds maximum allowed duration of ${MAX_AUDIO_DURATION_SECONDS} seconds`],
    };
  }

  return { valid: true };
}

export function validateAudioBuffer(buffer: Buffer | ArrayBuffer): ValidationResult {
  if (!buffer || buffer.byteLength === 0) {
    return {
      valid: false,
      errors: ['Audio buffer is empty'],
    };
  }

  return { valid: true };
}
