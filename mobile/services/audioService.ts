import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { Platform } from 'react-native';
import { getApiUrl } from '../utils/api';

// Recording preset configuration
const RECORDING_OPTIONS = {
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
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
};

export class AudioRecorder {
  private recording: Audio.Recording | null = null;
  private preparedRecording: Audio.Recording | null = null;  // Pre-prepared recording
  private sound: Audio.Sound | null = null;
  private ready = false;
  private lastStartLatency = 0;  // Track measured latency

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
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
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

  /**
   * Get the latency from the last recording start (in seconds)
   * This can be used to adjust the startTime of the recorded segment
   */
  getLastStartLatency(): number {
    return this.lastStartLatency;
  }

  /**
   * Pre-prepare a recording so startRecording() is faster
   * Call this ahead of time when you know recording will happen soon
   */
  async prepareRecording(): Promise<void> {
    if (!this.ready) {
      throw new Error('AudioRecorder not initialized');
    }

    // Clean up any existing prepared recording
    if (this.preparedRecording) {
      try {
        await this.preparedRecording.stopAndUnloadAsync();
      } catch (e) {
        // Ignore
      }
      this.preparedRecording = null;
    }

    try {
      console.log('[AudioRecorder] Pre-preparing recording...');
      const prepareStart = Date.now();
      
      this.preparedRecording = new Audio.Recording();
      await this.preparedRecording.prepareToRecordAsync(RECORDING_OPTIONS);
      
      const prepareTime = Date.now() - prepareStart;
      console.log(`[AudioRecorder] Recording prepared in ${prepareTime}ms`);
    } catch (error) {
      console.error('[AudioRecorder] Failed to prepare recording:', error);
      this.preparedRecording = null;
      throw error;
    }
  }

  /**
   * Start recording. If prepareRecording() was called, this will be much faster.
   * Returns the timestamp when recording actually started (after any latency).
   */
  async startRecording(): Promise<number> {
    if (!this.ready) {
      throw new Error('AudioRecorder not initialized');
    }

    const overallStart = Date.now();

    try {
      // Use pre-prepared recording if available
      if (this.preparedRecording) {
        console.log('[AudioRecorder] Using pre-prepared recording');
        this.recording = this.preparedRecording;
        this.preparedRecording = null;
        
        const startTime = Date.now();
        await this.recording.startAsync();
        const actualStartTime = Date.now();
        
        this.lastStartLatency = (actualStartTime - overallStart) / 1000;
        console.log(`[AudioRecorder] Recording started (pre-prepared), latency: ${this.lastStartLatency * 1000}ms`);
        
        return actualStartTime;
      }

      // Fall back to creating new recording
      console.log('[AudioRecorder] Creating new recording (not pre-prepared)');
      this.recording = new Audio.Recording();

      await this.recording.prepareToRecordAsync(RECORDING_OPTIONS);

      const startTime = Date.now();
      await this.recording.startAsync();
      const actualStartTime = Date.now();
      
      this.lastStartLatency = (actualStartTime - overallStart) / 1000;
      console.log(`[AudioRecorder] Recording started (fresh), latency: ${this.lastStartLatency * 1000}ms`);
      
      return actualStartTime;
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

      if (!uploadUrlResponse.ok) {
        throw new Error(`Failed to get upload URL: ${uploadUrlResponse.status}`);
      }

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
