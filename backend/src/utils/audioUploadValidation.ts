// Validation for the audio upload/save contract. Kept pure and separate from
// the route handlers so it can be unit tested and reused.

const ALLOWED_CONTENT_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
]);

const ALLOWED_EXTENSIONS = new Set([
  'wav', 'webm', 'm4a', 'mp4', 'aac', 'mp3', 'ogg', 'caf', 'flac',
]);

const MAX_FILENAME_LENGTH = 128;

/** True if the client-supplied filename is a plain, safe basename we can key on. */
export function isValidUploadFilename(filename: unknown): filename is string {
  if (typeof filename !== 'string') return false;
  if (filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) return false;
  // No path separators, parent refs, or NUL — the filename becomes part of an
  // S3 key, so it must not be able to escape the audio/ prefix.
  if (/[/\\]/.test(filename) || filename.includes('..') || filename.includes('\0')) {
    return false;
  }
  // Only safe basename characters.
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return false;
  const ext = filename.split('.').pop()?.toLowerCase();
  return !!ext && ALLOWED_EXTENSIONS.has(ext);
}

/** True if the content type is one of the audio types we accept. */
export function isValidUploadContentType(contentType: unknown): contentType is string {
  if (contentType === undefined) return true; // optional; a default is applied
  return typeof contentType === 'string' && ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase());
}

// Keys are minted as `audio/<uuid v4>-<safe filename>` by generateUploadUrl.
const AUDIO_KEY_PATTERN = /^audio\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[A-Za-z0-9._-]+$/;

/** True if the key looks like one this service minted (not arbitrary client input). */
export function isValidAudioKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 256 && AUDIO_KEY_PATTERN.test(key);
}
