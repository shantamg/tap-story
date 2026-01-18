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
 * - Single render callback drives both input and output (perfect sync)
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
- (void)start;

/**
 * Stop audio playback.
 * Does not reset the frame position.
 */
- (void)stop;

/**
 * Start recording to a file.
 * Recording will begin when the current frame reaches startFrame.
 *
 * @param filePath Path to write raw PCM data (Int16, mono, 44100Hz)
 * @param startFrame Frame number to start recording at
 */
- (void)startRecordingToPath:(NSString *)filePath startFrame:(int32_t)startFrame;

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

/**
 * Get the number of samples recorded so far.
 *
 * @return Number of samples recorded
 */
- (int64_t)recordedSampleCount;

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

