//
//  AudioEngineIOS.mm
//  TapStory
//
//  Low-latency audio engine using RemoteIO AudioUnit for synchronized
//  playback and recording. This is the iOS equivalent of the Android Oboe engine.
//
//  Key features:
//  - Single render callback drives both playback AND recording (perfect sync)
//  - Frame-accurate multi-track mixing
//  - Low buffer duration (~5ms) for minimal latency
//  - Same mixing algorithm as Android for cross-platform consistency
//

#import "AudioEngineIOS.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <mach/mach_time.h>
#include <vector>
#include <mutex>
#include <atomic>
#include <fstream>
#include <cmath>

// MARK: - Constants

static const int32_t kSampleRate = 44100;
static const int32_t kChannelCountOut = 2;  // Stereo output
static const int32_t kChannelCountIn = 1;   // Mono input

// MARK: - Track Structure (mirrors Android)

struct Track {
    std::vector<float> data;
    int32_t startFrame;
    int32_t lengthFrames;
};

// MARK: - AudioEngineIOS Private Implementation

@interface AudioEngineIOS () {
    AudioUnit _remoteIOUnit;
    
    // Tracks
    std::vector<Track> _tracks;
    std::mutex _trackMutex;
    
    // Playback state
    std::atomic<int64_t> _currentFrame;
    std::atomic<bool> _isRunning;
    
    // Recording state
    std::atomic<bool> _isRecording;
    std::ofstream _recordingFile;
    int32_t _recordStartFrame;
    std::atomic<int64_t> _recordedSampleCount;
    NSString *_recordingFilePath;
    
    // Input buffer for recording (allocated once)
    std::vector<int16_t> _inputBuffer;
    
    // Audio format
    AudioStreamBasicDescription _outputFormat;
    AudioStreamBasicDescription _inputFormat;
}

@end

// MARK: - Render Callback (The Heartbeat)

static OSStatus RenderCallback(
    void *inRefCon,
    AudioUnitRenderActionFlags *ioActionFlags,
    const AudioTimeStamp *inTimeStamp,
    UInt32 inBusNumber,
    UInt32 inNumberFrames,
    AudioBufferList *ioData)
{
    AudioEngineIOS *engine = (__bridge AudioEngineIOS *)inRefCon;
    return [engine performRenderWithActionFlags:ioActionFlags
                                      timeStamp:inTimeStamp
                                      busNumber:inBusNumber
                                    numberFrames:inNumberFrames
                                       bufferList:ioData];
}

// MARK: - AudioEngineIOS Implementation

@implementation AudioEngineIOS

- (instancetype)init {
    self = [super init];
    if (self) {
        _currentFrame = 0;
        _isRunning = false;
        _isRecording = false;
        _recordStartFrame = 0;
        _recordedSampleCount = 0;
        
        NSLog(@"[AudioEngineIOS] Created");
    }
    return self;
}

- (void)dealloc {
    [self cleanup];
    NSLog(@"[AudioEngineIOS] Destroyed");
}

// MARK: - Audio Session Setup

- (BOOL)setupAudioSession:(NSError **)outError {
    NSError *error = nil;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    
    // CRITICAL: PlayAndRecord allows simultaneous In/Out
    // DefaultToSpeaker ensures sound doesn't go to the tiny earpiece
    // AllowBluetooth lets users use AirPods (essential!)
    AVAudioSessionCategoryOptions options =
        AVAudioSessionCategoryOptionDefaultToSpeaker |
        AVAudioSessionCategoryOptionAllowBluetooth |
        AVAudioSessionCategoryOptionMixWithOthers;
    
    [session setCategory:AVAudioSessionCategoryPlayAndRecord
             withOptions:options
                   error:&error];
    
    if (error) {
        NSLog(@"[AudioEngineIOS] Failed to set audio session category: %@", error);
        if (outError) *outError = error;
        return NO;
    }
    
    // Set a low hardware buffer duration (~5ms) for strict sync
    // Note: iOS may adjust this, but it will get as close as possible
    [session setPreferredIOBufferDuration:0.005 error:&error];
    if (error) {
        NSLog(@"[AudioEngineIOS] Warning: Could not set preferred buffer duration: %@", error);
        // Continue anyway - this is a preference, not a requirement
    }
    
    // Set sample rate
    [session setPreferredSampleRate:kSampleRate error:&error];
    if (error) {
        NSLog(@"[AudioEngineIOS] Warning: Could not set preferred sample rate: %@", error);
    }
    
    // Activate the session
    [session setActive:YES error:&error];
    if (error) {
        NSLog(@"[AudioEngineIOS] Failed to activate audio session: %@", error);
        if (outError) *outError = error;
        return NO;
    }
    
    // Log actual hardware values
    NSLog(@"[AudioEngineIOS] Audio Session configured:");
    NSLog(@"  Sample Rate: %.0f Hz", session.sampleRate);
    NSLog(@"  IO Buffer Duration: %.3f ms", session.IOBufferDuration * 1000);
    NSLog(@"  Input Latency: %.3f ms", session.inputLatency * 1000);
    NSLog(@"  Output Latency: %.3f ms", session.outputLatency * 1000);
    
    return YES;
}

// MARK: - AudioUnit Setup

- (BOOL)setupAudioUnit:(NSError **)outError {
    OSStatus status;
    
    // Describe the RemoteIO unit
    AudioComponentDescription desc = {
        .componentType = kAudioUnitType_Output,
        .componentSubType = kAudioUnitSubType_RemoteIO,
        .componentManufacturer = kAudioUnitManufacturer_Apple,
        .componentFlags = 0,
        .componentFlagsMask = 0
    };
    
    AudioComponent component = AudioComponentFindNext(NULL, &desc);
    if (!component) {
        NSLog(@"[AudioEngineIOS] Failed to find RemoteIO component");
        if (outError) {
            *outError = [NSError errorWithDomain:@"AudioEngineIOS"
                                            code:-1
                                        userInfo:@{NSLocalizedDescriptionKey: @"RemoteIO component not found"}];
        }
        return NO;
    }
    
    status = AudioComponentInstanceNew(component, &_remoteIOUnit);
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to create AudioUnit: %d", (int)status);
        if (outError) {
            *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        }
        return NO;
    }
    
    // Enable input (microphone) on the RemoteIO unit
    UInt32 enableInput = 1;
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Input,
                                  1,  // Bus 1 = input
                                  &enableInput,
                                  sizeof(enableInput));
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to enable input: %d", (int)status);
    }
    
    // Enable output (speaker) - should already be enabled by default
    UInt32 enableOutput = 1;
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Output,
                                  0,  // Bus 0 = output
                                  &enableOutput,
                                  sizeof(enableOutput));
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to enable output: %d", (int)status);
    }
    
    // Set up the output format (what we send to the speaker)
    // Using Float32 for high-quality mixing (same as Android)
    _outputFormat = {
        .mSampleRate = (Float64)kSampleRate,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = sizeof(Float32) * kChannelCountOut,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = sizeof(Float32) * kChannelCountOut,
        .mChannelsPerFrame = kChannelCountOut,
        .mBitsPerChannel = sizeof(Float32) * 8,
        .mReserved = 0
    };
    
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Input,  // Input to the output bus
                                  0,  // Bus 0 = output
                                  &_outputFormat,
                                  sizeof(_outputFormat));
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to set output format: %d", (int)status);
    }
    
    // Set up the input format (what we get from the microphone)
    // Using Int16 for recording (same as Android)
    _inputFormat = {
        .mSampleRate = (Float64)kSampleRate,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = sizeof(SInt16) * kChannelCountIn,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = sizeof(SInt16) * kChannelCountIn,
        .mChannelsPerFrame = kChannelCountIn,
        .mBitsPerChannel = sizeof(SInt16) * 8,
        .mReserved = 0
    };
    
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Output,  // Output from the input bus
                                  1,  // Bus 1 = input
                                  &_inputFormat,
                                  sizeof(_inputFormat));
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to set input format: %d", (int)status);
    }
    
    // Set up the render callback
    AURenderCallbackStruct callbackStruct = {
        .inputProc = RenderCallback,
        .inputProcRefCon = (__bridge void *)self
    };
    
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_SetRenderCallback,
                                  kAudioUnitScope_Input,
                                  0,  // Bus 0 = output
                                  &callbackStruct,
                                  sizeof(callbackStruct));
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to set render callback: %d", (int)status);
        if (outError) {
            *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        }
        return NO;
    }
    
    // Initialize the AudioUnit
    status = AudioUnitInitialize(_remoteIOUnit);
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to initialize AudioUnit: %d", (int)status);
        if (outError) {
            *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        }
        return NO;
    }
    
    NSLog(@"[AudioEngineIOS] AudioUnit configured successfully");
    return YES;
}

// MARK: - Public API

- (BOOL)initialize:(NSError **)outError {
    NSLog(@"[AudioEngineIOS] Initializing");
    
    if (![self setupAudioSession:outError]) {
        return NO;
    }
    
    if (![self setupAudioUnit:outError]) {
        return NO;
    }
    
    // Pre-allocate input buffer (will be resized in callback if needed)
    _inputBuffer.resize(4096);
    
    NSLog(@"[AudioEngineIOS] Initialized successfully");
    return YES;
}

- (void)loadTrackWithId:(NSString *)trackId
                   data:(const int16_t *)data
             numSamples:(int32_t)numSamples
             startFrame:(int32_t)startFrame {
    std::lock_guard<std::mutex> lock(_trackMutex);
    
    Track track;
    track.startFrame = startFrame;
    track.lengthFrames = numSamples;
    track.data.resize(numSamples);
    
    // Convert Int16 to Float for high-quality mixing
    // Same logic as Android: Int16 range [-32768, 32767] -> Float range [-1.0, 1.0]
    const float scalar = 1.0f / 32768.0f;
    for (int32_t i = 0; i < numSamples; ++i) {
        track.data[i] = static_cast<float>(data[i]) * scalar;
    }
    
    _tracks.push_back(std::move(track));
    
    NSLog(@"[AudioEngineIOS] Loaded track '%@': %d samples, startFrame=%d",
          trackId, numSamples, startFrame);
}

- (void)clearTracks {
    std::lock_guard<std::mutex> lock(_trackMutex);
    _tracks.clear();
    NSLog(@"[AudioEngineIOS] Cleared all tracks");
}

- (void)start {
    if (_isRunning.load()) {
        NSLog(@"[AudioEngineIOS] Already running");
        return;
    }
    
    NSLog(@"[AudioEngineIOS] Starting at frame %lld", _currentFrame.load());
    
    OSStatus status = AudioOutputUnitStart(_remoteIOUnit);
    if (status != noErr) {
        NSLog(@"[AudioEngineIOS] Failed to start AudioUnit: %d", (int)status);
        return;
    }
    
    _isRunning.store(true);
    NSLog(@"[AudioEngineIOS] Started successfully");
}

- (void)stop {
    if (!_isRunning.load()) {
        return;
    }
    
    NSLog(@"[AudioEngineIOS] Stopping");
    
    _isRunning.store(false);
    AudioOutputUnitStop(_remoteIOUnit);
    
    NSLog(@"[AudioEngineIOS] Stopped");
}

- (void)startRecordingToPath:(NSString *)filePath startFrame:(int32_t)startFrame {
    _recordStartFrame = startFrame;
    _recordedSampleCount.store(0);
    _recordingFilePath = filePath;
    
    _recordingFile.open([filePath UTF8String], std::ios::binary);
    
    if (_recordingFile.is_open()) {
        _isRecording.store(true);
        NSLog(@"[AudioEngineIOS] Recording started: path=%@, startFrame=%d", filePath, startFrame);
    } else {
        NSLog(@"[AudioEngineIOS] Failed to open recording file: %@", filePath);
    }
}

- (void)stopRecording {
    _isRecording.store(false);
    
    if (_recordingFile.is_open()) {
        _recordingFile.close();
        NSLog(@"[AudioEngineIOS] Recording stopped: %lld samples captured",
              _recordedSampleCount.load());
    }
}

- (void)seekToFrame:(int64_t)frame {
    NSLog(@"[AudioEngineIOS] Seeking to frame %lld (%.2f seconds)",
          frame, (double)frame / kSampleRate);
    _currentFrame.store(frame);
}

- (int64_t)currentFrame {
    return _currentFrame.load();
}

- (int64_t)recordingStartFrame {
    return _recordStartFrame;
}

- (int64_t)recordedSampleCount {
    return _recordedSampleCount.load();
}

- (NSDictionary *)getLatencyInfo {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    return @{
        @"inputLatencyMs": @(session.inputLatency * 1000),
        @"outputLatencyMs": @(session.outputLatency * 1000),
        @"bufferDurationMs": @(session.IOBufferDuration * 1000),
        @"sampleRate": @(session.sampleRate)
    };
}

- (void)cleanup {
    NSLog(@"[AudioEngineIOS] Cleaning up");
    
    [self stop];
    [self stopRecording];
    [self clearTracks];
    
    if (_remoteIOUnit) {
        AudioUnitUninitialize(_remoteIOUnit);
        AudioComponentInstanceDispose(_remoteIOUnit);
        _remoteIOUnit = NULL;
    }
    
    NSLog(@"[AudioEngineIOS] Cleaned up");
}

// MARK: - Render Callback Implementation (The Critical Sync Loop)

- (OSStatus)performRenderWithActionFlags:(AudioUnitRenderActionFlags *)ioActionFlags
                               timeStamp:(const AudioTimeStamp *)inTimeStamp
                               busNumber:(UInt32)inBusNumber
                             numberFrames:(UInt32)inNumberFrames
                              bufferList:(AudioBufferList *)ioData {
    
    int64_t currentFrame = _currentFrame.load();
    
    // ---------------------------------------------------------
    // 1. RECORDING (Input) - Read from mic synchronously
    // ---------------------------------------------------------
    if (_isRecording.load() && _recordingFile.is_open()) {
        // Ensure input buffer is large enough
        if (_inputBuffer.size() < inNumberFrames) {
            _inputBuffer.resize(inNumberFrames);
        }
        
        // Set up buffer list for input
        AudioBufferList inputBufferList;
        inputBufferList.mNumberBuffers = 1;
        inputBufferList.mBuffers[0].mDataByteSize = inNumberFrames * sizeof(SInt16);
        inputBufferList.mBuffers[0].mNumberChannels = kChannelCountIn;
        inputBufferList.mBuffers[0].mData = _inputBuffer.data();
        
        // Pull input from the microphone (Bus 1)
        OSStatus status = AudioUnitRender(_remoteIOUnit,
                                          ioActionFlags,
                                          inTimeStamp,
                                          1,  // Bus 1 = input
                                          inNumberFrames,
                                          &inputBufferList);
        
        if (status == noErr) {
            // Only write if currentFrame >= recordStartFrame
            if (currentFrame >= _recordStartFrame) {
                _recordingFile.write(reinterpret_cast<const char*>(_inputBuffer.data()),
                                     inNumberFrames * sizeof(SInt16));
                _recordedSampleCount.fetch_add(inNumberFrames);
            }
        }
    }
    
    // ---------------------------------------------------------
    // 2. MIXING (Output) - Same algorithm as Android
    // ---------------------------------------------------------
    // Get output buffer (stereo interleaved float)
    Float32 *outputBuffer = (Float32 *)ioData->mBuffers[0].mData;
    UInt32 outputBufferSize = inNumberFrames * kChannelCountOut;
    
    // Clear buffer (Silence)
    memset(outputBuffer, 0, outputBufferSize * sizeof(Float32));
    
    {
        std::lock_guard<std::mutex> lock(_trackMutex);
        
        for (const auto& track : _tracks) {
            // Calculate overlap between current buffer window and track
            int64_t trackOffset = currentFrame - track.startFrame;
            
            // If track is playing in this window
            if (trackOffset < track.lengthFrames && (trackOffset + inNumberFrames) > 0) {
                for (UInt32 i = 0; i < inNumberFrames; ++i) {
                    int64_t sampleIndex = trackOffset + i;
                    
                    if (sampleIndex >= 0 && sampleIndex < track.lengthFrames) {
                        float sample = track.data[sampleIndex];
                        
                        // Simple Mixing: Add to Stereo L and R
                        // outputBuffer is interleaved: [L, R, L, R...]
                        outputBuffer[i * 2] += sample;       // Left
                        outputBuffer[i * 2 + 1] += sample;   // Right
                    }
                }
            }
        }
    }
    
    // Soft clipping to prevent harsh distortion (same as Android)
    for (UInt32 i = 0; i < outputBufferSize; ++i) {
        float sample = outputBuffer[i];
        // Soft clip using tanh for samples exceeding [-1, 1]
        if (sample > 1.0f || sample < -1.0f) {
            outputBuffer[i] = tanhf(sample);
        }
    }
    
    // Advance the frame counter
    _currentFrame.fetch_add(inNumberFrames);
    
    return noErr;
}

@end

