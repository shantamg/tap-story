import { Audio, AVPlaybackStatus } from 'expo-av';
import { localAudioExists, getLocalAudioPath, downloadAndCacheAudio } from './audioStorage';

interface AudioSegment {
  id: string;
  audioUrl: string;       // Remote S3 presigned URL
  localUri?: string;      // Local file URI (if available)
  duration: number;
  startTime: number;      // When this segment starts in the timeline
  sound?: Audio.Sound;
}

let instanceCounter = 0;

export class DuetPlayer {
  private segments: AudioSegment[] = [];
  private isPlaying = false;
  private instanceId: number;
  private playbackStartTime = 0;      // When playback started (Date.now())
  private timelinePosition = 0;       // Current position in timeline (seconds)
  private positionUpdateInterval: NodeJS.Timeout | null = null;
  private startedSegments: Set<string> = new Set();  // Track which segments we've started

  constructor() {
    this.instanceId = ++instanceCounter;
    this.log('Instance created');
  }

  private log(...args: any[]) {
    console.log(`[DuetPlayer #${this.instanceId}]`, ...args);
  }

  async loadChain(chain: Array<{ id: string; audioUrl: string; localUri?: string; duration: number; startTime: number }>): Promise<void> {
    this.log('loadChain called with', chain.length, 'segments');

    // Clean up existing sounds
    await this.cleanup();

    // Store segments with their timeline positions
    this.segments = chain.map(node => ({
      id: node.id,
      audioUrl: node.audioUrl,
      localUri: node.localUri,
      duration: node.duration,
      startTime: node.startTime,
    }));

    // Log the timeline
    for (const seg of this.segments) {
      this.log(`Segment ${seg.id.slice(0, 8)}: starts at ${seg.startTime}s, duration ${seg.duration}s, ends at ${seg.startTime + seg.duration}s`);
    }

    // Preload all sounds
    this.log('Preloading all sounds...');
    for (const segment of this.segments) {
      const uri = await this.getPlaybackUri(segment);
      this.log('Preloading segment', segment.id.slice(0, 8));
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: false }
      );
      segment.sound = sound;
    }
    this.log('All sounds preloaded');
  }

  getTotalDuration(): number {
    if (this.segments.length === 0) return 0;
    // Total duration is the latest end time
    return Math.max(...this.segments.map(seg => seg.startTime + seg.duration));
  }

  /**
   * Play the chain from a position, with optional callback when reaching a specific time
   * @param position - Timeline position to start from (seconds)
   * @param callbackTime - Optional time to trigger the callback (seconds)
   * @param onReachTime - Callback to trigger when reaching callbackTime
   */
  async playFrom(position: number, callbackTime?: number, onReachTime?: () => void): Promise<void> {
    this.log('playFrom called, position:', position, 'callbackTime:', callbackTime);
    this.isPlaying = true;
    this.timelinePosition = position;
    this.playbackStartTime = Date.now();
    this.startedSegments.clear();

    let callbackTriggered = false;

    // Start all segments that should be playing at this position
    for (const segment of this.segments) {
      const segmentEnd = segment.startTime + segment.duration;

      // Should this segment be playing at the current position?
      if (segment.startTime <= position && segmentEnd > position) {
        // Calculate position within this segment
        const segmentPosition = position - segment.startTime;
        this.log(`Starting segment ${segment.id.slice(0, 8)} at position ${segmentPosition}s`);

        if (segment.sound) {
          await segment.sound.setPositionAsync(segmentPosition * 1000);
          await segment.sound.playAsync();
          this.startedSegments.add(segment.id);
        }
      }
    }

    // Set up position tracking and segment triggering
    this.positionUpdateInterval = setInterval(async () => {
      if (!this.isPlaying) {
        if (this.positionUpdateInterval) {
          clearInterval(this.positionUpdateInterval);
          this.positionUpdateInterval = null;
        }
        return;
      }

      // Calculate current timeline position
      const elapsedMs = Date.now() - this.playbackStartTime;
      this.timelinePosition = position + (elapsedMs / 1000);

      // Check if we need to trigger the callback
      if (callbackTime !== undefined && onReachTime && !callbackTriggered) {
        if (this.timelinePosition >= callbackTime) {
          this.log('Reached callback time:', callbackTime);
          callbackTriggered = true;
          onReachTime();
        }
      }

      // Check if we need to start any segments that haven't been started yet
      for (const segment of this.segments) {
        // Skip if we've already started this segment
        if (this.startedSegments.has(segment.id)) continue;
        if (!segment.sound) continue;

        const segmentEnd = segment.startTime + segment.duration;

        // Should this segment start now?
        if (segment.startTime <= this.timelinePosition && segmentEnd > this.timelinePosition) {
          // Mark as started BEFORE async operations to prevent duplicate starts
          this.startedSegments.add(segment.id);

          // Calculate position within this segment
          const segmentPosition = this.timelinePosition - segment.startTime;
          this.log(`Starting segment ${segment.id.slice(0, 8)} at timeline position ${this.timelinePosition.toFixed(1)}s (segment position ${segmentPosition.toFixed(1)}s)`);

          try {
            await segment.sound.setPositionAsync(segmentPosition * 1000);
            await segment.sound.playAsync();
          } catch (error) {
            this.log(`Error starting segment ${segment.id.slice(0, 8)}:`, error);
          }
        }
      }

      // Check if all segments are done
      const totalDuration = this.getTotalDuration();
      if (this.timelinePosition >= totalDuration) {
        this.log('Reached end of timeline');
        this.isPlaying = false;
        if (this.positionUpdateInterval) {
          clearInterval(this.positionUpdateInterval);
          this.positionUpdateInterval = null;
        }
      }
    }, 50); // Check every 50ms for smooth triggering
  }

  /**
   * Get the best URI to use for playback - local if available, otherwise remote
   */
  private async getPlaybackUri(segment: AudioSegment): Promise<string> {
    if (segment.localUri) {
      return segment.localUri;
    }

    const hasLocal = await localAudioExists(segment.id);
    if (hasLocal) {
      return getLocalAudioPath(segment.id);
    }

    try {
      const localPath = await downloadAndCacheAudio(segment.audioUrl, segment.id);
      return localPath;
    } catch (error) {
      console.warn('Failed to cache audio, using remote URL:', error);
      return segment.audioUrl;
    }
  }

  async getCurrentPosition(): Promise<number> {
    return this.timelinePosition;
  }

  async stop(): Promise<void> {
    this.log('stop called');
    this.isPlaying = false;

    if (this.positionUpdateInterval) {
      clearInterval(this.positionUpdateInterval);
      this.positionUpdateInterval = null;
    }

    for (const segment of this.segments) {
      if (segment.sound) {
        try {
          await segment.sound.stopAsync();
        } catch (error) {
          this.log('Error stopping sound:', error);
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    this.log('cleanup called');
    await this.stop();

    for (const segment of this.segments) {
      if (segment.sound) {
        try {
          await segment.sound.unloadAsync();
        } catch (error) {
          this.log('Error unloading sound:', error);
        }
        segment.sound = undefined;
      }
    }

    this.segments = [];
    this.startedSegments.clear();
  }
}
