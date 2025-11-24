export function generateAudioUrl(nodeId: string, baseUrl?: string): string {
  const base = baseUrl || process.env.STORAGE_BASE_URL || 'https://storage.tapstory.app';
  return `${base}/audio/${nodeId}.mp3`;
}

export function generateUploadUrl(nodeId: string, baseUrl?: string): string {
  const base = baseUrl || process.env.API_BASE_URL || 'http://localhost:3000';
  return `${base}/api/upload/${nodeId}`;
}

export function parseNodeIdFromUrl(url: string): string | null {
  const match = url.match(/\/audio\/([^/.]+)\./);
  return match ? match[1] : null;
}
