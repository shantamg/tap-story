import { Audio, AVPlaybackStatus } from 'expo-av';
import { localAudioExists, getLocalAudioPath, downloadAndCacheAudio } from './audioStorage';

interface AudioSegment {
  id: string;
  audioUrl: string;       // Remote S3 presigned URL
  localUri?: string;      // Local file URI (if available)
  duration: number;
  startTime?: number;
  sound?: Audio.Sound;
}

export class DuetPlayer {
  private segments: AudioSegment[] = [];
  private currentSegmentIndex = 0;
  private playbackStartTime = 0;
  private isPlaying = false;

  async loadChain(chain: Array<{ id: string; audioUrl: string; localUri?: string; duration: number }>): Promise<void> {
    // Clean up existing sounds
    await this.cleanup();

    let cumulativeTime = 0;
    this.segments = chain.map(node => {
      const segment: AudioSegment = {
        id: node.id,
        audioUrl: node.audioUrl,
        localUri: node.localUri,
        startTime: cumulativeTime,
        duration: node.duration,
      };
      cumulativeTime += node.duration;
      return segment;
    });
  }

  getTotalDuration(): number {
    return this.segments.reduce((sum, seg) => sum + seg.duration, 0);
  }

  async playFrom(position: number): Promise<void> {
    this.playbackStartTime = position;

    // Find which segment to start from
    let segmentIndex = 0;
    let segmentStartPosition = 0;

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      if (position < (segment.startTime! + segment.duration)) {
        segmentIndex = i;
        segmentStartPosition = position - segment.startTime!;
        break;
      }
    }

    this.currentSegmentIndex = segmentIndex;
    await this.playSegmentChain(segmentIndex, segmentStartPosition);
  }

  /**
   * Get the best URI to use for playback - local if available, otherwise remote
   */
  private async getPlaybackUri(segment: AudioSegment): Promise<string> {
    // If we have a local URI passed in, use it
    if (segment.localUri) {
      return segment.localUri;
    }

    // Check if we have it cached locally
    const hasLocal = await localAudioExists(segment.id);
    if (hasLocal) {
      return getLocalAudioPath(segment.id);
    }

    // Fall back to remote URL (and cache it for next time)
    try {
      const localPath = await downloadAndCacheAudio(segment.audioUrl, segment.id);
      return localPath;
    } catch (error) {
      console.warn('Failed to cache audio, using remote URL:', error);
      return segment.audioUrl;
    }
  }

  private async playSegmentChain(startIndex: number, startPosition: number): Promise<void> {
    this.isPlaying = true;

    for (let i = startIndex; i < this.segments.length && this.isPlaying; i++) {
      const segment = this.segments[i];

      // Get the best URI (local preferred, remote fallback)
      const uri = await this.getPlaybackUri(segment);

      // Load the audio
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        {
          shouldPlay: true,
          positionMillis: i === startIndex ? startPosition * 1000 : 0,
        }
      );

      segment.sound = sound;

      // Set up completion listener for chaining
      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (status.isLoaded && status.didJustFinish) {
          // Move to next segment
          if (i < this.segments.length - 1) {
            this.currentSegmentIndex = i + 1;
          }
        }
      });

      // Wait for this segment to complete
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(async () => {
          const status = await sound.getStatusAsync();
          if (status.isLoaded && (status.didJustFinish || !this.isPlaying)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
    }

    this.isPlaying = false;
  }

  async getCurrentPosition(): Promise<number> {
    if (this.currentSegmentIndex >= this.segments.length) {
      return this.getTotalDuration();
    }

    const currentSegment = this.segments[this.currentSegmentIndex];
    if (currentSegment.sound) {
      const status = await currentSegment.sound.getStatusAsync();
      if (status.isLoaded) {
        return currentSegment.startTime! + (status.positionMillis / 1000);
      }
    }

    return currentSegment.startTime || 0;
  }

  async stop(): Promise<void> {
    this.isPlaying = false;

    for (const segment of this.segments) {
      if (segment.sound) {
        await segment.sound.stopAsync();
      }
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();

    for (const segment of this.segments) {
      if (segment.sound) {
        await segment.sound.unloadAsync();
        segment.sound = undefined;
      }
    }

    this.segments = [];
  }

  getRecordingStartPoint(): number {
    // Return where the next recording should start (after all current segments)
    return this.getTotalDuration();
  }
}
