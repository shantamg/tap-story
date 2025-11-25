import { Audio } from 'expo-av';
import { Platform } from 'react-native';
import { getApiUrl } from '../utils/api';

export class AudioRecorder {
  private recording: Audio.Recording | null = null;
  private sound: Audio.Sound | null = null;
  private ready = false;

  async init(): Promise<void> {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Audio recording permission not granted');
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      this.ready = true;
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      throw error;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  async startRecording(): Promise<void> {
    if (!this.ready) {
      throw new Error('AudioRecorder not initialized');
    }

    try {
      this.recording = new Audio.Recording();

      await this.recording.prepareToRecordAsync({
        android: {
          extension: '.webm',
          outputFormat: Audio.AndroidOutputFormat.WEBM,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: 44100,
          numberOfChannels: 2,
          bitRate: 128000,
        },
        web: {
          mimeType: 'audio/webm',
          bitsPerSecond: 128000,
        },
      });

      await this.recording.startAsync();
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.recording = null;
      throw error;
    }
  }

  async stopRecording(): Promise<string> {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    try {
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recording = null;

      if (!uri) {
        throw new Error('Failed to get recording URI');
      }

      return uri;
    } catch (error) {
      console.error('Failed to stop recording:', error);
      throw error;
    }
  }

  async uploadRecording(uri: string): Promise<string> {
    try {
      const apiUrl = getApiUrl();

      // Determine file extension and content type based on platform
      const isIOS = Platform.OS === 'ios';
      const filename = isIOS ? 'recording.m4a' : 'recording.webm';
      const contentType = isIOS ? 'audio/mp4' : 'audio/webm';

      // Get presigned URL
      const uploadUrlResponse = await fetch(`${apiUrl}/api/audio/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, contentType }),
      });

      const { uploadUrl, key } = await uploadUrlResponse.json();

      // Upload file to S3
      const fileBlob = await fetch(uri).then(r => r.blob());

      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: fileBlob,
        headers: {
          'Content-Type': contentType,
        },
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload to S3');
      }

      return key;
    } catch (error) {
      console.error('Upload failed:', error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.recording) {
      try {
        await this.recording.stopAndUnloadAsync();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.recording = null;
    }

    if (this.sound) {
      try {
        await this.sound.unloadAsync();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.sound = null;
    }
  }
}
