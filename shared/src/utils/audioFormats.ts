import { AudioFormat } from '../types/audio';

export function getAudioMimeType(format: AudioFormat): string {
  const mimeTypes: Record<AudioFormat, string> = {
    [AudioFormat.MP3]: 'audio/mpeg',
    [AudioFormat.M4A]: 'audio/mp4',
    [AudioFormat.WAV]: 'audio/wav',
    [AudioFormat.AAC]: 'audio/aac',
  };

  return mimeTypes[format] || 'audio/mpeg';
}

export function getAudioFormatFromMimeType(mimeType: string): AudioFormat {
  const formats: Record<string, AudioFormat> = {
    'audio/mpeg': AudioFormat.MP3,
    'audio/mp3': AudioFormat.MP3,
    'audio/mp4': AudioFormat.M4A,
    'audio/m4a': AudioFormat.M4A,
    'audio/wav': AudioFormat.WAV,
    'audio/wave': AudioFormat.WAV,
    'audio/aac': AudioFormat.AAC,
  };

  return formats[mimeType.toLowerCase()] || AudioFormat.MP3;
}

export function getAudioFormatFromExtension(extension: string): AudioFormat {
  const normalized = extension.toLowerCase().replace('.', '');

  switch (normalized) {
    case 'mp3':
      return AudioFormat.MP3;
    case 'm4a':
      return AudioFormat.M4A;
    case 'wav':
      return AudioFormat.WAV;
    case 'aac':
      return AudioFormat.AAC;
    default:
      return AudioFormat.MP3;
  }
}
