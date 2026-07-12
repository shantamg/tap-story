//
//  AudioEngineIOS.h
//  TapStory
//
//  Low-latency audio engine using RemoteIO AudioUnit.
//  This is the iOS equivalent of the Android Oboe engine.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * AudioEngineIOS - Core audio engine for synchronized playback and recording on iOS
 *
 * Uses RemoteIO AudioUnit to provide:
 * - One render callback drives deterministic input/output frame alignment
 * - Frame-accurate multi-track mixing
 * - Low buffer duration (~5ms) for minimal latency
 * - Same mixing algorithm as Android for cross-platform consistency
 *
 * Unlike AVAudioEngine, this uses the low-level AudioUnit API which allows:
 * - Direct control over the render loop
 * - Synchronized read/write in the same callback
 * - Reuse of C++ mixing logic from Android
 */
@interface AudioEngineIOS : NSObject

/** Called from the background capture-writer queue after the first PCM frame is accepted. */
@property (nonatomic, copy, nullable) void (^recordingStartedHandler)(int64_t timelineFrame);

/**
 * Initialize the audio engine.
 * Sets up the audio session and creates the RemoteIO AudioUnit.
 *
 * @param outError Error if initialization fails
 * @return YES on success, NO on failure
 */
- (BOOL)initialize:(NSError **)outError;

/**
 * Load a track into the mixer.
 *
 * @param trackId Unique identifier for the track
 * @param data Pointer to Int16 PCM samples (mono)
 * @param numSamples Number of samples in the data
 * @param startFrame Frame number where this track starts playing
 */
- (void)loadTrackWithId:(NSString *)trackId
                   data:(const int16_t *)data
             numSamples:(int32_t)numSamples
             startFrame:(int32_t)startFrame;

/**
 * Clear all loaded tracks.
 */
- (void)clearTracks;

/**
 * Start audio playback.
 * If tracks are loaded, they will be mixed according to their startFrame positions.
 */
- (BOOL)start:(NSError **)outError;

/**
 * Stop audio playback.
 * Does not reset the frame position.
 */
- (void)stop;

/**
 * Start recording to a file.
 * Recording will begin when the current frame reaches startFrame.
 *
 * @param filePath Path to write raw PCM data (Int16 mono at the active route rate)
 * @param startFrame Logical timeline frame at which the new recording is aligned
 * @param outError Error returned when the writer cannot be armed
 */
- (BOOL)startRecordingToPath:(NSString *)filePath
                  startFrame:(int64_t)startFrame
                       error:(NSError **)outError;

/**
 * Stop recording.
 */
- (void)stopRecording;

/**
 * Seek to a specific frame position.
 *
 * @param frame The frame number to seek to
 */
- (void)seekToFrame:(int64_t)frame;

/**
 * Get the current playback position in frames.
 *
 * @return Current frame number
 */
- (int64_t)currentFrame;

/**
 * Get the frame number where recording started.
 *
 * @return Recording start frame
 */
- (int64_t)recordingStartFrame;

/** The render timeline frame at which the first captured PCM sample arrived. */
- (int64_t)actualRecordingStartFrame;

/** The exclusive render timeline end frame of the captured PCM span. */
- (int64_t)recordingTimelineEndFrame;

/**
 * Get the number of samples recorded so far.
 *
 * @return Number of samples recorded
 */
- (int64_t)recordedSampleCount;

/** Frames dropped because the real-time capture ring did not have capacity. */
- (int64_t)recordingOverflowFrameCount;

/** Input render failures observed while capture was armed. */
- (int64_t)recordingInputErrorCount;

/** Render sample-time jumps observed while this take was armed. */
- (int64_t)recordingTimelineDiscontinuityCount;

/** Whether an interruption, route change, or media reset invalidated this take. */
- (BOOL)recordingRouteInvalidated;

/** Whether the background PCM writer encountered a file error. */
- (BOOL)recordingWriteFailed;

/** The active hardware sample rate used by the RemoteIO graph. */
- (double)sampleRate;

/** Whether the transport callback is active. */
- (BOOL)isRunning;

/**
 * Configure capture latency compensation.
 * Zero restores automatic input + output route latency; a positive value
 * overrides the total compensation for subsequent recordings.
 */
- (void)setLatencyCompensationMs:(double)milliseconds;

/** Fail closed after an audio-session route/interruption notification. */
- (void)invalidateAudioRoute;

/**
 * Get latency information from the audio session.
 *
 * @return Dictionary with inputLatencyMs, outputLatencyMs, bufferDurationMs, sampleRate
 */
- (NSDictionary *)getLatencyInfo;

/**
 * Clean up all resources.
 * Should be called when the engine is no longer needed.
 */
- (void)cleanup;

@end

NS_ASSUME_NONNULL_END
