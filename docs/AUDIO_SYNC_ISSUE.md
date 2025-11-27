# Audio Synchronization Issue - Expert Advice Needed

## Problem Summary

We're building a React Native app (Expo) that enables collaborative audio recording similar to TikTok duets or multi-track recording apps like GarageBand. Users record audio on top of previously recorded tracks, and when played back together, they need to be perfectly synchronized.

**Current Issue**: When recording a new track while playing back existing tracks, the recorded audio is noticeably out of sync with the playback. The drift appears to be variable (sometimes 100-300ms off), making it impossible to create properly aligned multi-track recordings.

## Use Case

1. **First Recording (A)**: User records audio. Starts at timeline position 0.
2. **Second Recording (B)**: User presses record. Track A plays back while user records Track B. Track B starts at position 0 (duet).
3. **Third+ Recording**: Previous tracks play. New recording starts when a specific timeline position is reached (e.g., when the oldest track ends).

The critical requirement is that when all tracks are played back together, they are sample-accurate or at least perceptually synchronized (within ~5-10ms).

## What We've Built (Android Native Module)

We moved away from expo-av (JavaScript-based timing) to a native Kotlin module using `AudioTrack` for playback and `AudioRecord` for recording. The theory was that using the same sample rate and tracking frame positions would give us accurate sync.

### Architecture

```
React Native (TypeScript)
    ↓
TapStoryAudioModule.kt (React Native Bridge)
    ↓
TapStoryAudioEngine.kt (Core Engine)
    - AudioTrack for multi-track mixing/playback
    - AudioRecord for recording
    - Separate HandlerThreads for playback and recording
```

### Core Audio Engine (TapStoryAudioEngine.kt)

```kotlin
package com.tapstory.audio

class TapStoryAudioEngine(private val context: Context) {

    companion object {
        private const val SAMPLE_RATE = 44100
        private const val CHANNEL_CONFIG_OUT = AudioFormat.CHANNEL_OUT_STEREO
        private const val CHANNEL_CONFIG_IN = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    }

    private var nativeAudioTrack: android.media.AudioTrack? = null
    private var audioRecord: AudioRecord? = null

    private var playbackThread: HandlerThread? = null
    private var recordThread: HandlerThread? = null

    private val isPlaying = AtomicBoolean(false)
    private val isRecording = AtomicBoolean(false)

    // Pre-decoded PCM audio for each track
    private var decodedAudio: MutableMap<String, ShortArray> = mutableMapOf()

    // Timing tracking
    private val playbackStartTimeNanos = AtomicLong(0)
    private val playbackStartPositionMs = AtomicLong(0)
    private val recordingActualStartMs = AtomicLong(0)

    private var recordingBuffer: MutableList<Short> = mutableListOf()

    /**
     * Main playback loop - mixes all tracks and optionally triggers recording
     */
    private fun startPlaybackInternal(
        playFromMs: Long,
        recordStartMs: Long,
        onRecordingStarted: ((Long) -> Unit)?
    ) {
        val bufferSize = android.media.AudioTrack.getMinBufferSize(
            SAMPLE_RATE, CHANNEL_CONFIG_OUT, AUDIO_FORMAT
        ) * 2

        nativeAudioTrack = android.media.AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AUDIO_FORMAT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_CONFIG_OUT)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(android.media.AudioTrack.MODE_STREAM)
            .build()

        nativeAudioTrack?.play()

        val framesPerBuffer = bufferSize / (CHANNELS_OUT * BYTES_PER_SAMPLE)
        var currentFramePosition = (playFromMs * SAMPLE_RATE / 1000).toInt()
        var recordingStarted = false

        val mixBuffer = ShortArray(framesPerBuffer * CHANNELS_OUT)

        while (isPlaying.get()) {
            val currentPositionMs = currentFramePosition.toLong() * 1000 / SAMPLE_RATE

            // Check if we should start recording
            if (!recordingStarted && recordStartMs >= 0 && currentPositionMs >= recordStartMs) {
                recordingStarted = true
                recordingActualStartMs.set(currentPositionMs)

                // Start recording on separate thread
                recordHandler?.post {
                    startRecordingInternal()
                }

                onRecordingStarted?.invoke(currentPositionMs)
            }

            // Mix audio from all tracks into mixBuffer
            mixBuffer.fill(0)
            for (track in loadedTracks) {
                val pcmData = decodedAudio[track.id] ?: continue
                val trackStartFrame = (track.startTimeMs * SAMPLE_RATE / 1000).toInt()
                val trackFramePosition = currentFramePosition - trackStartFrame

                if (trackFramePosition >= 0) {
                    for (i in 0 until framesPerBuffer * CHANNELS_OUT) {
                        val sourceSample = (trackFramePosition * CHANNELS_OUT) + i
                        if (sourceSample < pcmData.size) {
                            val mixed = mixBuffer[i].toInt() + pcmData[sourceSample].toInt()
                            mixBuffer[i] = clamp(mixed)
                        }
                    }
                }
            }

            // Write to AudioTrack
            nativeAudioTrack?.write(mixBuffer, 0, mixBuffer.size)
            currentFramePosition += framesPerBuffer
        }
    }

    /**
     * Recording loop - runs on separate thread
     */
    private fun startRecordingInternal() {
        val bufferSize = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, CHANNEL_CONFIG_IN, AUDIO_FORMAT
        ) * 2

        audioRecord = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.MIC)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AUDIO_FORMAT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_CONFIG_IN)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .build()

        isRecording.set(true)
        audioRecord?.startRecording()

        val buffer = ShortArray(bufferSize / BYTES_PER_SAMPLE)

        while (isRecording.get() && isPlaying.get()) {
            val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
            if (read > 0) {
                synchronized(recordingBuffer) {
                    for (i in 0 until read) {
                        recordingBuffer.add(buffer[i])
                    }
                }
            }
        }

        audioRecord?.stop()
        audioRecord?.release()
    }
}
```

### React Native Bridge (TapStoryAudioModule.kt)

```kotlin
@ReactMethod
fun playAndRecord(playFromMs: Double, recordStartMs: Double, promise: Promise) {
    audioEngine?.playAndRecord(
        playFromMs.toLong(),
        recordStartMs.toLong()
    ) { actualStartMs ->
        // Emit event when recording actually starts
        sendEvent("onRecordingStarted", Arguments.createMap().apply {
            putDouble("actualStartMs", actualStartMs.toDouble())
        })
    }
    promise.resolve(null)
}
```

### TypeScript Integration (DuetTrackPlayer.ts)

```typescript
async playFrom(
  position: number,
  callbackTime?: number,
  onReachTime?: () => void
): Promise<void> {
  if (this.nativeEngine) {
    const positionMs = position * 1000;
    const callbackTimeMs = callbackTime !== undefined ? callbackTime * 1000 : -1;

    if (callbackTime !== undefined && onReachTime) {
      // Use playAndRecord for synchronized recording trigger
      await this.nativeEngine.playAndRecord(
        positionMs,
        callbackTimeMs,
        (actualStartMs: number) => {
          console.log(`Native recording started at ${actualStartMs}ms`);
          onReachTime();
        }
      );
    } else {
      await this.nativeEngine.play(positionMs);
    }
    return;
  }

  // Fallback to expo-av...
}
```

## Known Issues with Current Implementation

1. **Separate Threads**: Playback and recording run on separate `HandlerThread`s. While we trigger recording from the playback loop, there's no guarantee they share the same audio clock.

2. **No AAudio/Oboe**: We're using the high-level `AudioTrack`/`AudioRecord` APIs instead of AAudio or Oboe, which would provide lower latency and better timing control.

3. **Buffer Size Mismatch**: Playback and recording may have different buffer sizes, causing timing drift.

4. **No Hardware Timestamp**: We're calculating position from frame counts, but not using `AudioTrack.getTimestamp()` or `AudioRecord.getTimestamp()` for hardware-accurate timing.

5. **Recording Trigger Latency**: When we detect it's time to start recording (`currentPositionMs >= recordStartMs`), we post to another thread. This introduces latency between the decision and actual recording start.

6. **Sample Rate Conversion**: Source audio files are decoded via `MediaCodec`, but we don't verify they match our target 44.1kHz sample rate.

## Questions for Experts

1. **Is this architecture fundamentally flawed?** Should playback and recording be on the same callback/thread to share a clock?

2. **Should we use Oboe/AAudio instead?** Would switching to Oboe give us the low-latency, synchronized audio we need? Can Oboe handle both playback and recording in the same callback?

3. **How do professional apps achieve sync?** Apps like GarageBand, BandLab, or even TikTok duets seem to achieve perfect sync. What's their approach?

4. **Hardware timestamps**: Should we use `AudioTrack.getTimestamp()` and `AudioRecord.getTimestamp()` to get the actual hardware time, then compensate for the difference?

5. **Shared audio stream**: Is there a way to use a single audio stream for both input and output, ensuring they share the same clock?

6. **Pre-roll and punch-in**: Should we start recording before the target time and trim, rather than trying to start at the exact moment?

7. **Latency measurement**: Should we play a known signal, record it, and measure the round-trip latency to calibrate?

## Environment

- React Native 0.81.5 (New Architecture enabled)
- Expo SDK 54
- Android API 24+ (targeting 36)
- Physical test device: Samsung Galaxy A15 (SM-A155M)
- Emulator: Medium Phone API 36

## Desired Outcome

We want to achieve sync accuracy within ~5-10ms, similar to what professional multi-track recording apps achieve. The key is:

1. When recording starts at a specific timeline position (e.g., 5000ms), the recording should align precisely with that position when played back.
2. Multiple recordings made at different times should all play back in sync.
3. The solution should work reliably across different Android devices.

## Additional Context

We're also planning to implement this for iOS using `AVAudioEngine`, which should be more straightforward since iOS provides a unified audio graph with shared timing. But fixing Android first is the priority.

Any guidance on the correct approach would be greatly appreciated!
