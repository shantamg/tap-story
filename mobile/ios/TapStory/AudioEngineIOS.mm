//
//  AudioEngineIOS.mm
//  TapStory
//
//  RemoteIO full-duplex engine. The render callback only pulls input, copies
//  capture PCM into a lock-free SPSC ring, and mixes immutable tracks. File I/O
//  and React Native notification happen on a background writer queue.
//

#import "AudioEngineIOS.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <thread>
#include <vector>

namespace {

constexpr int32_t kOutputChannelCount = 2;
constexpr int32_t kInputChannelCount = 1;
constexpr size_t kWriterChunkFrames = 8192;
constexpr int64_t kUnsetFrame = -1;
constexpr int64_t kPublishingFrame = -2;

enum class CaptureStartState : uint8_t {
    Pending,
    Started,
    Cancelled,
};

static_assert(std::atomic<CaptureStartState>::is_always_lock_free);

size_t nextPowerOfTwo(size_t value) {
    if (value <= 1) return 1;
    --value;
    for (size_t shift = 1; shift < sizeof(size_t) * 8; shift <<= 1) {
        value |= value >> shift;
    }
    return value + 1;
}

struct Track {
    std::vector<float> samples;
    int64_t startFrame = 0;
    int64_t lengthFrames = 0;
};

/** Single-producer/single-consumer PCM ring with monotonic cursors. */
class PcmRing {
public:
    void configure(size_t minimumCapacity) {
        const size_t capacity = nextPowerOfTwo(minimumCapacity);
        samples_.assign(capacity, 0);
        mask_ = capacity - 1;
        reset();
    }

    void reset() {
        readCursor_.store(0, std::memory_order_relaxed);
        writeCursor_.store(0, std::memory_order_relaxed);
    }

    size_t write(const int16_t *source, size_t count) noexcept {
        if (samples_.empty() || count == 0) return 0;

        const uint64_t writeCursor = writeCursor_.load(std::memory_order_relaxed);
        const uint64_t readCursor = readCursor_.load(std::memory_order_acquire);
        const size_t used = static_cast<size_t>(writeCursor - readCursor);
        const size_t writable = std::min(count, samples_.size() - used);
        const size_t index = static_cast<size_t>(writeCursor) & mask_;
        const size_t firstCopy = std::min(writable, samples_.size() - index);

        if (firstCopy > 0) {
            std::memcpy(samples_.data() + index, source, firstCopy * sizeof(int16_t));
        }
        const size_t secondCopy = writable - firstCopy;
        if (secondCopy > 0) {
            std::memcpy(samples_.data(), source + firstCopy, secondCopy * sizeof(int16_t));
        }

        writeCursor_.store(writeCursor + writable, std::memory_order_release);
        return writable;
    }

    size_t read(int16_t *destination, size_t count) noexcept {
        if (samples_.empty() || count == 0) return 0;

        const uint64_t readCursor = readCursor_.load(std::memory_order_relaxed);
        const uint64_t writeCursor = writeCursor_.load(std::memory_order_acquire);
        const size_t readable = std::min(count, static_cast<size_t>(writeCursor - readCursor));
        const size_t index = static_cast<size_t>(readCursor) & mask_;
        const size_t firstCopy = std::min(readable, samples_.size() - index);

        if (firstCopy > 0) {
            std::memcpy(destination, samples_.data() + index, firstCopy * sizeof(int16_t));
        }
        const size_t secondCopy = readable - firstCopy;
        if (secondCopy > 0) {
            std::memcpy(destination + firstCopy, samples_.data(), secondCopy * sizeof(int16_t));
        }

        readCursor_.store(readCursor + readable, std::memory_order_release);
        return readable;
    }

    size_t size() const noexcept {
        const uint64_t writeCursor = writeCursor_.load(std::memory_order_acquire);
        const uint64_t readCursor = readCursor_.load(std::memory_order_acquire);
        return static_cast<size_t>(writeCursor - readCursor);
    }

    size_t capacity() const noexcept {
        return samples_.size();
    }

private:
    std::vector<int16_t> samples_;
    size_t mask_ = 0;
    alignas(64) std::atomic<uint64_t> readCursor_ { 0 };
    alignas(64) std::atomic<uint64_t> writeCursor_ { 0 };
};

class CallbackActivityGuard {
public:
    explicit CallbackActivityGuard(std::atomic<uint32_t> &counter) : counter_(counter) {
        counter_.fetch_add(1, std::memory_order_acq_rel);
    }

    ~CallbackActivityGuard() {
        counter_.fetch_sub(1, std::memory_order_acq_rel);
    }

private:
    std::atomic<uint32_t> &counter_;
};

NSError *makeEngineError(NSInteger code, NSString *message) {
    return [NSError errorWithDomain:@"AudioEngineIOS"
                               code:code
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

} // namespace

@interface AudioEngineIOS () {
    AudioUnit _remoteIOUnit;
    AudioStreamBasicDescription _outputFormat;
    AudioStreamBasicDescription _inputFormat;
    double _sampleRate;
    UInt32 _maximumFramesPerSlice;

    // Track storage is mutated only while transport is stopped. It is immutable
    // for the entire lifetime of an active render callback.
    std::vector<Track> _tracks;

    std::atomic<bool> _initialized;
    std::atomic<bool> _isRunning;
    std::atomic<bool> _outputMuted;
    std::atomic<int64_t> _firstMutedOutputFrame;
    std::atomic<int64_t> _currentFrame;
    std::atomic<uint32_t> _callbackActivityCount;
    std::atomic<double> _lastRenderSampleTime;
    std::atomic<uint32_t> _lastRenderFrameCount;
    std::atomic<bool> _routeInvalidated;

    // Capture state shared with the real-time producer. The start state makes
    // the first punch and a concurrent cancellation one atomic decision.
    std::atomic<bool> _captureArmed;
    std::atomic<CaptureStartState> _captureStartState;
    std::atomic<int64_t> _requestedRecordStartFrame;
    std::atomic<int64_t> _captureGateFrame;
    std::atomic<int64_t> _actualRecordStartFrame;
    std::atomic<int64_t> _captureTimelineEndFrame;
    std::atomic<int64_t> _captureStopFrame;
    std::atomic<int64_t> _latencyCompensationFrames;
    std::atomic<int64_t> _overflowFrameCount;
    std::atomic<int64_t> _inputRenderErrorCount;
    std::atomic<int64_t> _timelineDiscontinuityCount;
    std::atomic<bool> _captureRouteInvalidated;

    // The input buffer and ring storage are allocated before transport starts.
    std::vector<int16_t> _inputBuffer;
    PcmRing _captureRing;

    // Only the background writer touches the stream after it is opened.
    std::ofstream _recordingFile;
    dispatch_queue_t _writerQueue;
    dispatch_group_t _writerGroup;
    std::atomic<bool> _writerActive;
    std::atomic<bool> _writerStopRequested;
    std::atomic<bool> _writerFailed;
    std::atomic<int64_t> _writtenSampleCount;

    // Snapshot of the route values used to align this capture.
    std::atomic<double> _configuredLatencyCompensationMs;
    std::atomic<double> _appliedInputLatencySeconds;
    std::atomic<double> _appliedOutputLatencySeconds;
    std::atomic<double> _automaticLatencyCompensationMs;
    std::atomic<double> _effectiveLatencyCompensationMs;
    std::atomic<bool> _latencyCompensationWasOverridden;
}

- (BOOL)setupAudioSession:(NSError **)outError;
- (BOOL)setupAudioUnit:(NSError **)outError;
- (void)drainRecordingRing;
- (OSStatus)performRenderWithActionFlags:(AudioUnitRenderActionFlags *)ioActionFlags
                               timeStamp:(const AudioTimeStamp *)inTimeStamp
                               busNumber:(UInt32)inBusNumber
                             numberFrames:(UInt32)inNumberFrames
                              bufferList:(AudioBufferList *)ioData;

@end

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

@implementation AudioEngineIOS

- (instancetype)init {
    self = [super init];
    if (self) {
        _remoteIOUnit = NULL;
        _sampleRate = 0;
        _maximumFramesPerSlice = 0;
        _initialized.store(false);
        _isRunning.store(false);
        _outputMuted.store(false);
        _firstMutedOutputFrame.store(-1);
        _currentFrame.store(0);
        _callbackActivityCount.store(0);
        _lastRenderSampleTime.store(std::numeric_limits<double>::quiet_NaN());
        _lastRenderFrameCount.store(0);
        _routeInvalidated.store(false);
        _captureArmed.store(false);
        _captureStartState.store(CaptureStartState::Cancelled);
        _requestedRecordStartFrame.store(0);
        _captureGateFrame.store(0);
        _actualRecordStartFrame.store(-1);
        _captureTimelineEndFrame.store(-1);
        _captureStopFrame.store(-1);
        _latencyCompensationFrames.store(0);
        _overflowFrameCount.store(0);
        _inputRenderErrorCount.store(0);
        _timelineDiscontinuityCount.store(0);
        _captureRouteInvalidated.store(false);
        _writerActive.store(false);
        _writerStopRequested.store(false);
        _writerFailed.store(false);
        _writtenSampleCount.store(0);
        _configuredLatencyCompensationMs.store(0);
        _appliedInputLatencySeconds.store(0);
        _appliedOutputLatencySeconds.store(0);
        _automaticLatencyCompensationMs.store(0);
        _effectiveLatencyCompensationMs.store(0);
        _latencyCompensationWasOverridden.store(false);
        _writerQueue = dispatch_queue_create("com.tapstory.audio.capture-writer", DISPATCH_QUEUE_SERIAL);
        _writerGroup = dispatch_group_create();
        NSLog(@"[AudioEngineIOS] Created");
    }
    return self;
}

- (void)dealloc {
    [self cleanup];
    NSLog(@"[AudioEngineIOS] Destroyed");
}

- (BOOL)setupAudioSession:(NSError **)outError {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    NSError *error = nil;
    const AVAudioSessionCategoryOptions options =
        AVAudioSessionCategoryOptionDefaultToSpeaker |
        AVAudioSessionCategoryOptionAllowBluetooth |
        AVAudioSessionCategoryOptionMixWithOthers;

    [session setCategory:AVAudioSessionCategoryPlayAndRecord
             withOptions:options
                   error:&error];
    if (error) {
        if (outError) *outError = error;
        return NO;
    }

    [session setPreferredIOBufferDuration:0.005 error:&error];
    if (error) {
        NSLog(@"[AudioEngineIOS] Could not set preferred buffer duration: %@", error);
        error = nil;
    }

    [session setActive:YES error:&error];
    if (error) {
        if (outError) *outError = error;
        return NO;
    }

    _sampleRate = session.sampleRate;
    if (_sampleRate <= 0) {
        if (outError) *outError = makeEngineError(1, @"Active audio route reported an invalid sample rate");
        return NO;
    }

    _appliedInputLatencySeconds.store(session.inputLatency, std::memory_order_relaxed);
    _appliedOutputLatencySeconds.store(session.outputLatency, std::memory_order_relaxed);
    const double automaticCompensationMs = (session.inputLatency + session.outputLatency) * 1000;
    _automaticLatencyCompensationMs.store(automaticCompensationMs, std::memory_order_relaxed);
    _effectiveLatencyCompensationMs.store(automaticCompensationMs, std::memory_order_relaxed);
    NSLog(@"[AudioEngineIOS] Route sampleRate=%.0fHz buffer=%.3fms input=%.3fms output=%.3fms",
          _sampleRate,
          session.IOBufferDuration * 1000,
          session.inputLatency * 1000,
          session.outputLatency * 1000);
    return YES;
}

- (BOOL)setupAudioUnit:(NSError **)outError {
    const AudioComponentDescription description = {
        .componentType = kAudioUnitType_Output,
        .componentSubType = kAudioUnitSubType_RemoteIO,
        .componentManufacturer = kAudioUnitManufacturer_Apple,
        .componentFlags = 0,
        .componentFlagsMask = 0
    };
    AudioComponent component = AudioComponentFindNext(NULL, &description);
    if (!component) {
        if (outError) *outError = makeEngineError(2, @"RemoteIO component not found");
        return NO;
    }

    OSStatus status = AudioComponentInstanceNew(component, &_remoteIOUnit);
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    UInt32 enable = 1;
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Input,
                                  1,
                                  &enable,
                                  sizeof(enable));
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Output,
                                  0,
                                  &enable,
                                  sizeof(enable));
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    _outputFormat = {
        .mSampleRate = _sampleRate,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = sizeof(Float32) * kOutputChannelCount,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = sizeof(Float32) * kOutputChannelCount,
        .mChannelsPerFrame = kOutputChannelCount,
        .mBitsPerChannel = sizeof(Float32) * 8,
        .mReserved = 0
    };
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Input,
                                  0,
                                  &_outputFormat,
                                  sizeof(_outputFormat));
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    _inputFormat = {
        .mSampleRate = _sampleRate,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = sizeof(SInt16) * kInputChannelCount,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = sizeof(SInt16) * kInputChannelCount,
        .mChannelsPerFrame = kInputChannelCount,
        .mBitsPerChannel = sizeof(SInt16) * 8,
        .mReserved = 0
    };
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Output,
                                  1,
                                  &_inputFormat,
                                  sizeof(_inputFormat));
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    AURenderCallbackStruct callback = {
        .inputProc = RenderCallback,
        .inputProcRefCon = (__bridge void *)self
    };
    status = AudioUnitSetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_SetRenderCallback,
                                  kAudioUnitScope_Input,
                                  0,
                                  &callback,
                                  sizeof(callback));
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    status = AudioUnitInitialize(_remoteIOUnit);
    if (status != noErr) {
        if (outError) *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        return NO;
    }

    UInt32 propertySize = sizeof(_maximumFramesPerSlice);
    status = AudioUnitGetProperty(_remoteIOUnit,
                                  kAudioUnitProperty_MaximumFramesPerSlice,
                                  kAudioUnitScope_Global,
                                  0,
                                  &_maximumFramesPerSlice,
                                  &propertySize);
    if (status != noErr || _maximumFramesPerSlice == 0) {
        if (outError) *outError = makeEngineError(3, @"RemoteIO reported no maximum frame slice size");
        return NO;
    }

    return YES;
}

- (BOOL)initialize:(NSError **)outError {
    if (_routeInvalidated.load(std::memory_order_acquire)) {
        [self cleanup];
    }
    if (_initialized.load(std::memory_order_acquire)) return YES;

    if (![self setupAudioSession:outError] || ![self setupAudioUnit:outError]) {
        [self cleanup];
        return NO;
    }

    _inputBuffer.assign(_maximumFramesPerSlice, 0);
    const size_t routeFrames = static_cast<size_t>(std::ceil(_sampleRate * 4.0));
    const size_t burstFrames = static_cast<size_t>(_maximumFramesPerSlice) * 8;
    _captureRing.configure(std::max(routeFrames, burstFrames));
    _initialized.store(true, std::memory_order_release);
    _routeInvalidated.store(false, std::memory_order_release);

    NSLog(@"[AudioEngineIOS] Initialized at %.0fHz, maxSlice=%u, captureRing=%zu frames",
          _sampleRate,
          (unsigned)_maximumFramesPerSlice,
          _captureRing.capacity());
    return YES;
}

- (void)loadTrackWithId:(NSString *)trackId
                   data:(const int16_t *)data
             numSamples:(int32_t)numSamples
             startFrame:(int32_t)startFrame {
    if (_isRunning.load(std::memory_order_acquire)) {
        NSLog(@"[AudioEngineIOS] Refusing to mutate track '%@' while transport is running", trackId);
        return;
    }
    if (!data || numSamples <= 0) return;

    Track track;
    track.startFrame = startFrame;
    track.lengthFrames = numSamples;
    track.samples.resize(static_cast<size_t>(numSamples));
    constexpr float scalar = 1.0f / 32768.0f;
    for (int32_t index = 0; index < numSamples; ++index) {
        track.samples[static_cast<size_t>(index)] = static_cast<float>(data[index]) * scalar;
    }
    _tracks.push_back(std::move(track));
    NSLog(@"[AudioEngineIOS] Loaded '%@': %d frames at %d", trackId, numSamples, startFrame);
}

- (void)clearTracks {
    if (_isRunning.load(std::memory_order_acquire)) {
        NSLog(@"[AudioEngineIOS] Refusing to clear tracks while transport is running");
        return;
    }
    _tracks.clear();
}

- (BOOL)start:(NSError **)outError {
    if (!_initialized.load(std::memory_order_acquire)) {
        if (outError) *outError = makeEngineError(8, @"Audio engine is not initialized");
        return NO;
    }
    if (_routeInvalidated.load(std::memory_order_acquire)) {
        if (outError) {
            *outError = makeEngineError(
                10,
                @"Audio route changed or was interrupted; reinitialize and reload tracks"
            );
        }
        return NO;
    }
    AVAudioSession *session = [AVAudioSession sharedInstance];
    if (std::fabs(session.sampleRate - _sampleRate) > 0.5) {
        if (outError) {
            *outError = makeEngineError(
                9,
                @"Audio route sample rate changed; reinitialize and reload tracks"
            );
        }
        return NO;
    }
    bool expected = false;
    if (!_isRunning.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return YES;
    _lastRenderSampleTime.store(
        std::numeric_limits<double>::quiet_NaN(),
        std::memory_order_release
    );
    _lastRenderFrameCount.store(0, std::memory_order_release);
    _firstMutedOutputFrame.store(kUnsetFrame, std::memory_order_release);
    _outputMuted.store(false, std::memory_order_release);

    const OSStatus status = AudioOutputUnitStart(_remoteIOUnit);
    if (status != noErr) {
        _isRunning.store(false, std::memory_order_release);
        NSLog(@"[AudioEngineIOS] Failed to start RemoteIO: %d", (int)status);
        if (outError) {
            *outError = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
        }
        return NO;
    }
    return YES;
}

- (void)stop {
    if (!_isRunning.load(std::memory_order_acquire)) return;

    // Stop and the callback share this transition as the punch boundary. If
    // Stop changes Pending to Cancelled, an in-flight pre-punch callback must
    // discard its input. If the callback already changed it to Started, retain
    // the normal compensated capture tail even if actualStart is not published yet.
    CaptureStartState captureStartState = CaptureStartState::Pending;
    const bool cancelledPendingStart = _captureStartState.compare_exchange_strong(
        captureStartState,
        CaptureStartState::Cancelled,
        std::memory_order_acq_rel,
        std::memory_order_acquire
    );
    if (cancelledPendingStart) captureStartState = CaptureStartState::Cancelled;

    const int64_t compensationFrames =
        _latencyCompensationFrames.load(std::memory_order_acquire);
    const bool shouldDrainCaptureTail =
        _captureArmed.load(std::memory_order_acquire) &&
        captureStartState == CaptureStartState::Started &&
        compensationFrames > 0;
    if (shouldDrainCaptureTail) {
        // Input heard at logical frame E arrives C frames later. Keep the
        // duplex callback alive with silent output until that final input tail
        // is captured, then clip the last callback exactly at E + C.
        _firstMutedOutputFrame.store(kUnsetFrame, std::memory_order_release);
        _outputMuted.store(true, std::memory_order_release);
        const auto muteDeadline = std::chrono::steady_clock::now()
            + std::chrono::milliseconds(500);
        while (_firstMutedOutputFrame.load(std::memory_order_acquire) < 0 &&
               std::chrono::steady_clock::now() < muteDeadline) {
            std::this_thread::sleep_for(std::chrono::microseconds(250));
        }
        const int64_t transportStopFrame =
            _firstMutedOutputFrame.load(std::memory_order_acquire);
        const int64_t tailStopFrame = _captureStopFrame.load(std::memory_order_acquire);
        if (transportStopFrame >= 0 && tailStopFrame >= transportStopFrame) {
            const double tailSeconds = static_cast<double>(compensationFrames) / _sampleRate;
            const auto deadline = std::chrono::steady_clock::now()
                + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                    std::chrono::duration<double>(tailSeconds + 0.5)
                );
            while (_currentFrame.load(std::memory_order_acquire) < tailStopFrame &&
                   std::chrono::steady_clock::now() < deadline) {
                std::this_thread::sleep_for(std::chrono::microseconds(250));
            }
            if (_currentFrame.load(std::memory_order_acquire) < tailStopFrame) {
                _timelineDiscontinuityCount.fetch_add(1, std::memory_order_relaxed);
            }
        } else {
            _timelineDiscontinuityCount.fetch_add(1, std::memory_order_relaxed);
        }
    }

    AudioOutputUnitStop(_remoteIOUnit);
    _isRunning.store(false, std::memory_order_release);
    while (_callbackActivityCount.load(std::memory_order_acquire) != 0) {
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }
    _outputMuted.store(false, std::memory_order_release);
}

- (BOOL)startRecordingToPath:(NSString *)filePath
                  startFrame:(int64_t)startFrame
                       error:(NSError **)outError {
    if (!_initialized.load(std::memory_order_acquire)) {
        if (outError) *outError = makeEngineError(4, @"Audio engine is not initialized");
        return NO;
    }
    if (_routeInvalidated.load(std::memory_order_acquire)) {
        if (outError) *outError = makeEngineError(10, @"Audio route was invalidated; reinitialize first");
        return NO;
    }

    if (_captureArmed.load(std::memory_order_acquire) ||
        _writerActive.load(std::memory_order_acquire)) {
        [self stopRecording];
    }

    AVAudioSession *session = [AVAudioSession sharedInstance];
    if (std::fabs(session.sampleRate - _sampleRate) > 0.5) {
        if (outError) {
            *outError = makeEngineError(5, @"Audio route sample rate changed; reinitialize and reload tracks before recording");
        }
        return NO;
    }

    const double inputLatencySeconds = session.inputLatency;
    const double outputLatencySeconds = session.outputLatency;
    const double automaticCompensationMs = (inputLatencySeconds + outputLatencySeconds) * 1000;
    const double overrideMs = _configuredLatencyCompensationMs.load(std::memory_order_acquire);
    const bool usesOverride = overrideMs > 0;
    const double effectiveCompensationMs = usesOverride
        ? overrideMs
        : (_tracks.empty() ? inputLatencySeconds * 1000 : automaticCompensationMs);
    const double compensationFrameValue = effectiveCompensationMs * _sampleRate / 1000;
    if (!std::isfinite(compensationFrameValue) ||
        compensationFrameValue > static_cast<double>(std::numeric_limits<int64_t>::max())) {
        if (outError) *outError = makeEngineError(7, @"Latency compensation is too large");
        return NO;
    }

    if (_recordingFile.is_open()) _recordingFile.close();
    _recordingFile.clear();
    _recordingFile.open(filePath.fileSystemRepresentation,
                        std::ios::binary | std::ios::out | std::ios::trunc);
    if (!_recordingFile.is_open()) {
        if (outError) *outError = makeEngineError(6, @"Unable to open raw PCM capture file");
        return NO;
    }

    _captureRing.reset();
    _requestedRecordStartFrame.store(startFrame, std::memory_order_relaxed);
    _actualRecordStartFrame.store(kUnsetFrame, std::memory_order_relaxed);
    _captureTimelineEndFrame.store(kUnsetFrame, std::memory_order_relaxed);
    _captureStopFrame.store(kUnsetFrame, std::memory_order_relaxed);
    _overflowFrameCount.store(0, std::memory_order_relaxed);
    _inputRenderErrorCount.store(0, std::memory_order_relaxed);
    _timelineDiscontinuityCount.store(0, std::memory_order_relaxed);
    _captureRouteInvalidated.store(false, std::memory_order_relaxed);
    _writtenSampleCount.store(0, std::memory_order_relaxed);
    _writerFailed.store(false, std::memory_order_relaxed);
    _writerStopRequested.store(false, std::memory_order_relaxed);

    _appliedInputLatencySeconds.store(inputLatencySeconds, std::memory_order_relaxed);
    _appliedOutputLatencySeconds.store(outputLatencySeconds, std::memory_order_relaxed);
    _automaticLatencyCompensationMs.store(automaticCompensationMs, std::memory_order_relaxed);
    _effectiveLatencyCompensationMs.store(effectiveCompensationMs, std::memory_order_relaxed);
    _latencyCompensationWasOverridden.store(usesOverride, std::memory_order_relaxed);
    const int64_t compensationFrames = static_cast<int64_t>(std::llround(compensationFrameValue));
    if (startFrame < 0 || compensationFrames > std::numeric_limits<int64_t>::max() - startFrame) {
        _recordingFile.close();
        if (outError) *outError = makeEngineError(11, @"Capture punch frame is out of range");
        return NO;
    }
    _latencyCompensationFrames.store(compensationFrames, std::memory_order_relaxed);
    _captureGateFrame.store(startFrame + compensationFrames, std::memory_order_relaxed);

    _writerActive.store(true, std::memory_order_release);
    dispatch_group_async(_writerGroup, _writerQueue, ^{
        [self drainRecordingRing];
    });
    _captureStartState.store(CaptureStartState::Pending, std::memory_order_release);
    _captureArmed.store(true, std::memory_order_release);

    NSLog(@"[AudioEngineIOS] Capture armed requested=%lld gate=%lld compensation=%lld frames",
          startFrame,
          startFrame + compensationFrames,
          compensationFrames);
    return YES;
}

- (void)drainRecordingRing {
    std::array<int16_t, kWriterChunkFrames> chunk {};
    bool didNotifyStart = false;

    while (true) {
        const size_t count = _captureRing.read(chunk.data(), chunk.size());
        if (count > 0) {
            _recordingFile.write(reinterpret_cast<const char *>(chunk.data()),
                                 static_cast<std::streamsize>(count * sizeof(int16_t)));
            if (_recordingFile.good()) {
                _writtenSampleCount.fetch_add(static_cast<int64_t>(count), std::memory_order_relaxed);
            } else {
                _writerFailed.store(true, std::memory_order_release);
                _captureArmed.store(false, std::memory_order_release);
                _writerStopRequested.store(true, std::memory_order_release);
            }
        }

        if (!didNotifyStart) {
            const int64_t actualStart = _actualRecordStartFrame.load(std::memory_order_acquire);
            if (actualStart >= 0) {
                didNotifyStart = true;
                void (^handler)(int64_t) = self.recordingStartedHandler;
                if (handler) handler(actualStart);
            }
        }

        if (_writerStopRequested.load(std::memory_order_acquire) && _captureRing.size() == 0) {
            break;
        }
        if (count == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

    _recordingFile.flush();
    if (!_recordingFile.good()) _writerFailed.store(true, std::memory_order_release);
    _recordingFile.close();
    if (_recordingFile.fail()) _writerFailed.store(true, std::memory_order_release);
}

- (void)stopRecording {
    // Linearize cancellation against the callback's first capture slice. If
    // this wins while the punch is pending, no raced callback can publish a
    // valid start after Stop was requested.
    CaptureStartState pending = CaptureStartState::Pending;
    _captureStartState.compare_exchange_strong(
        pending,
        CaptureStartState::Cancelled,
        std::memory_order_acq_rel,
        std::memory_order_acquire
    );
    const bool hadCapture = _captureArmed.exchange(false, std::memory_order_acq_rel);
    const bool hadWriter = _writerActive.load(std::memory_order_acquire);
    if (!hadCapture && !hadWriter) return;

    // A callback that observed the old armed state must finish publishing before
    // the consumer is asked to drain and stop. New callbacks observe false.
    while (_callbackActivityCount.load(std::memory_order_acquire) != 0) {
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }

    _writerStopRequested.store(true, std::memory_order_release);
    if (hadWriter) {
        dispatch_group_wait(_writerGroup, DISPATCH_TIME_FOREVER);
        _writerActive.store(false, std::memory_order_release);
    }
    if (_recordingFile.is_open()) {
        _recordingFile.close();
        if (_recordingFile.fail()) _writerFailed.store(true, std::memory_order_release);
    }
}

- (void)seekToFrame:(int64_t)frame {
    if (_isRunning.load(std::memory_order_acquire)) {
        NSLog(@"[AudioEngineIOS] Refusing to seek while transport is running");
        return;
    }
    _currentFrame.store(frame, std::memory_order_release);
}

- (int64_t)currentFrame {
    return _currentFrame.load(std::memory_order_acquire);
}

- (int64_t)recordingStartFrame {
    const int64_t actualStart = _actualRecordStartFrame.load(std::memory_order_acquire);
    if (actualStart < 0) return _requestedRecordStartFrame.load(std::memory_order_acquire);
    const int64_t aligned = actualStart - _latencyCompensationFrames.load(std::memory_order_acquire);
    return std::max<int64_t>(0, aligned);
}

- (int64_t)actualRecordingStartFrame {
    return _actualRecordStartFrame.load(std::memory_order_acquire);
}

- (int64_t)recordingTimelineEndFrame {
    return _captureTimelineEndFrame.load(std::memory_order_acquire);
}

- (int64_t)recordedSampleCount {
    return _writtenSampleCount.load(std::memory_order_acquire);
}

- (int64_t)recordingOverflowFrameCount {
    return _overflowFrameCount.load(std::memory_order_acquire);
}

- (int64_t)recordingInputErrorCount {
    return _inputRenderErrorCount.load(std::memory_order_acquire);
}

- (int64_t)recordingTimelineDiscontinuityCount {
    return _timelineDiscontinuityCount.load(std::memory_order_acquire);
}

- (BOOL)recordingRouteInvalidated {
    return _captureRouteInvalidated.load(std::memory_order_acquire);
}

- (BOOL)recordingWriteFailed {
    return _writerFailed.load(std::memory_order_acquire);
}

- (double)sampleRate {
    return _sampleRate;
}

- (BOOL)isRunning {
    return _isRunning.load(std::memory_order_acquire);
}

- (void)setLatencyCompensationMs:(double)milliseconds {
    const double value = std::isfinite(milliseconds) && milliseconds > 0
        ? milliseconds
        : 0;
    _configuredLatencyCompensationMs.store(value, std::memory_order_release);

    // Preserve the snapshot of an in-flight capture. Otherwise make diagnostics
    // reflect the setting immediately, before the next recording is armed.
    if (!_captureArmed.load(std::memory_order_acquire) &&
        !_writerActive.load(std::memory_order_acquire)) {
        AVAudioSession *session = [AVAudioSession sharedInstance];
        const double automaticMs = (session.inputLatency + session.outputLatency) * 1000;
        const double effectiveMs = value > 0
            ? value
            : (_tracks.empty() ? session.inputLatency * 1000 : automaticMs);
        const double compensationFrameValue = effectiveMs * _sampleRate / 1000;
        _automaticLatencyCompensationMs.store(automaticMs, std::memory_order_relaxed);
        _effectiveLatencyCompensationMs.store(effectiveMs, std::memory_order_relaxed);
        _latencyCompensationWasOverridden.store(value > 0, std::memory_order_relaxed);
        if (std::isfinite(compensationFrameValue) &&
            compensationFrameValue <= static_cast<double>(std::numeric_limits<int64_t>::max())) {
            _latencyCompensationFrames.store(
                static_cast<int64_t>(std::llround(compensationFrameValue)),
                std::memory_order_relaxed);
        }
    }
}

- (void)invalidateAudioRoute {
    _routeInvalidated.store(true, std::memory_order_release);
    CaptureStartState pending = CaptureStartState::Pending;
    _captureStartState.compare_exchange_strong(
        pending,
        CaptureStartState::Cancelled,
        std::memory_order_acq_rel,
        std::memory_order_acquire
    );
    if (_captureArmed.exchange(false, std::memory_order_acq_rel) ||
        _writerActive.load(std::memory_order_acquire)) {
        _captureRouteInvalidated.store(true, std::memory_order_release);
    }
}

- (NSDictionary *)getLatencyInfo {
    AVAudioSession *session = [AVAudioSession sharedInstance];
    const int64_t actualStart = [self actualRecordingStartFrame];
    const int64_t timelineEnd = [self recordingTimelineEndFrame];
    const int64_t expectedFrames = actualStart >= 0 && timelineEnd >= actualStart
        ? timelineEnd - actualStart
        : 0;
    const double appliedInputLatencySeconds =
        _appliedInputLatencySeconds.load(std::memory_order_acquire);
    const double appliedOutputLatencySeconds =
        _appliedOutputLatencySeconds.load(std::memory_order_acquire);
    const bool wasOverridden =
        _latencyCompensationWasOverridden.load(std::memory_order_acquire);
    return @{
        @"inputLatencyMs": @(session.inputLatency * 1000),
        @"outputLatencyMs": @(session.outputLatency * 1000),
        @"roundTripLatencyMs": @((session.inputLatency + session.outputLatency) * 1000),
        @"bufferDurationMs": @(session.IOBufferDuration * 1000),
        @"sampleRate": @(_sampleRate),
        @"routeSampleRate": @(session.sampleRate),
        @"appliedInputLatencyMs": @(appliedInputLatencySeconds * 1000),
        @"appliedOutputLatencyMs": @(appliedOutputLatencySeconds * 1000),
        @"automaticLatencyCompensationMs": @(_automaticLatencyCompensationMs.load(std::memory_order_acquire)),
        @"configuredLatencyCompensationOverrideMs": @(_configuredLatencyCompensationMs.load(std::memory_order_acquire)),
        @"effectiveLatencyCompensationMs": @(_effectiveLatencyCompensationMs.load(std::memory_order_acquire)),
        @"latencyCompensationSource": wasOverridden ? @"manualOverride" : @"automaticRoute",
        @"latencyCompensationFrames": @(_latencyCompensationFrames.load(std::memory_order_acquire)),
        @"requestedStartFrame": @(_requestedRecordStartFrame.load(std::memory_order_acquire)),
        @"captureGateFrame": @(_captureGateFrame.load(std::memory_order_acquire)),
        @"actualCaptureStartFrame": @(actualStart),
        @"alignedStartFrame": @([self recordingStartFrame]),
        @"captureTimelineEndFrame": @(timelineEnd),
        @"expectedCaptureFrames": @(expectedFrames),
        @"writtenCaptureFrames": @([self recordedSampleCount]),
        @"overflowFrames": @([self recordingOverflowFrameCount]),
        @"inputRenderErrors": @([self recordingInputErrorCount]),
        @"timelineDiscontinuities": @([self recordingTimelineDiscontinuityCount]),
        @"routeInvalidated": @([self recordingRouteInvalidated]),
        @"writerFailed": @([self recordingWriteFailed]),
        @"ringCapacityFrames": @(_captureRing.capacity()),
        @"ringBufferedFrames": @(_captureRing.size()),
        @"maximumFramesPerSlice": @(_maximumFramesPerSlice)
    };
}

- (void)cleanup {
    [self stop];
    [self stopRecording];
    [self clearTracks];
    self.recordingStartedHandler = nil;

    if (_remoteIOUnit) {
        AudioUnitUninitialize(_remoteIOUnit);
        AudioComponentInstanceDispose(_remoteIOUnit);
        _remoteIOUnit = NULL;
    }
    _initialized.store(false, std::memory_order_release);
    _routeInvalidated.store(false, std::memory_order_release);
    _inputBuffer.clear();
    _captureRing.reset();
}

- (OSStatus)performRenderWithActionFlags:(AudioUnitRenderActionFlags *)ioActionFlags
                               timeStamp:(const AudioTimeStamp *)inTimeStamp
                               busNumber:(UInt32)inBusNumber
                             numberFrames:(UInt32)inNumberFrames
                              bufferList:(AudioBufferList *)ioData {
    CallbackActivityGuard activity(_callbackActivityCount);
    const int64_t currentFrame = _currentFrame.load(std::memory_order_relaxed);
    const bool outputMuted = _outputMuted.load(std::memory_order_acquire);
    if (outputMuted) {
        int64_t unset = kUnsetFrame;
        if (_firstMutedOutputFrame.compare_exchange_strong(
                unset,
                kPublishingFrame,
                std::memory_order_acq_rel,
                std::memory_order_relaxed)) {
            const int64_t compensationFrames =
                _latencyCompensationFrames.load(std::memory_order_acquire);
            if (compensationFrames <=
                std::numeric_limits<int64_t>::max() - currentFrame) {
                _captureStopFrame.store(
                    currentFrame + compensationFrames,
                    std::memory_order_relaxed
                );
            } else {
                _captureStopFrame.store(kUnsetFrame, std::memory_order_relaxed);
                _timelineDiscontinuityCount.fetch_add(1, std::memory_order_relaxed);
            }
            // This release publishes the stop frame before the control thread
            // can observe a non-negative mute boundary.
            _firstMutedOutputFrame.store(currentFrame, std::memory_order_release);
        }
    }

    if (inTimeStamp && (inTimeStamp->mFlags & kAudioTimeStampSampleTimeValid) != 0) {
        const double sampleTime = inTimeStamp->mSampleTime;
        const double previousSampleTime = _lastRenderSampleTime.exchange(
            sampleTime,
            std::memory_order_acq_rel
        );
        const uint32_t previousFrameCount = _lastRenderFrameCount.exchange(
            inNumberFrames,
            std::memory_order_acq_rel
        );
        if (std::isfinite(previousSampleTime)) {
            const double expectedSampleTime = previousSampleTime + previousFrameCount;
            if (std::fabs(sampleTime - expectedSampleTime) > 0.5 &&
                _captureArmed.load(std::memory_order_acquire)) {
                _timelineDiscontinuityCount.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }

    if (_captureArmed.load(std::memory_order_acquire)) {
        const int64_t frameCount = static_cast<int64_t>(inNumberFrames);
        const bool frameRangeValid =
            currentFrame <= std::numeric_limits<int64_t>::max() - frameCount;
        const int64_t bufferEndFrame = frameRangeValid
            ? currentFrame + frameCount
            : std::numeric_limits<int64_t>::max();
        const int64_t stopFrame = _captureStopFrame.load(std::memory_order_acquire);
        const bool captureAlreadyStopped = stopFrame >= 0 && currentFrame >= stopFrame;

        if (!frameRangeValid) {
            _timelineDiscontinuityCount.fetch_add(1, std::memory_order_relaxed);
            _captureArmed.store(false, std::memory_order_release);
        } else if (captureAlreadyStopped) {
            _captureArmed.store(false, std::memory_order_release);
        } else if (inNumberFrames <= _inputBuffer.size()) {
            AudioBufferList inputBuffers;
            inputBuffers.mNumberBuffers = 1;
            inputBuffers.mBuffers[0].mNumberChannels = kInputChannelCount;
            inputBuffers.mBuffers[0].mDataByteSize = inNumberFrames * sizeof(SInt16);
            inputBuffers.mBuffers[0].mData = _inputBuffer.data();

            const OSStatus inputStatus = AudioUnitRender(_remoteIOUnit,
                                                         ioActionFlags,
                                                         inTimeStamp,
                                                         1,
                                                         inNumberFrames,
                                                         &inputBuffers);
            if (inputStatus == noErr) {
                const int64_t gateFrame = _captureGateFrame.load(std::memory_order_relaxed);
                const int64_t captureEndFrame = stopFrame >= 0
                    ? std::min(bufferEndFrame, stopFrame)
                    : bufferEndFrame;
                const int64_t firstFrame = std::max(currentFrame, gateFrame);
                if (firstFrame < captureEndFrame) {
                    const size_t offset = static_cast<size_t>(firstFrame - currentFrame);
                    const size_t requestedCount = static_cast<size_t>(captureEndFrame - firstFrame);
                    CaptureStartState startState =
                        _captureStartState.load(std::memory_order_acquire);
                    if (startState == CaptureStartState::Pending) {
                        // This claim is the punch boundary. A concurrent
                        // pre-punch stop changes Pending to Cancelled instead.
                        const bool claimedStart = _captureStartState.compare_exchange_strong(
                            startState,
                            CaptureStartState::Started,
                            std::memory_order_acq_rel,
                            std::memory_order_acquire
                        );
                        if (claimedStart) startState = CaptureStartState::Started;
                    }
                    if (startState == CaptureStartState::Started) {
                        const size_t acceptedCount = _captureRing.write(
                            _inputBuffer.data() + offset,
                            requestedCount
                        );
                        if (acceptedCount > 0) {
                            int64_t unsetStart = kUnsetFrame;
                            _actualRecordStartFrame.compare_exchange_strong(
                                unsetStart,
                                firstFrame,
                                std::memory_order_release,
                                std::memory_order_relaxed
                            );
                        }
                        if (acceptedCount < requestedCount) {
                            _overflowFrameCount.fetch_add(
                                static_cast<int64_t>(requestedCount - acceptedCount),
                                std::memory_order_relaxed
                            );
                        }
                        _captureTimelineEndFrame.store(
                            captureEndFrame,
                            std::memory_order_release
                        );
                    }
                }
            } else {
                _inputRenderErrorCount.fetch_add(1, std::memory_order_relaxed);
            }
        } else {
            _inputRenderErrorCount.fetch_add(1, std::memory_order_relaxed);
        }
        // A failed input pull at the exclusive stop boundary invalidates the
        // take through diagnostics, but must never carry capture into a later
        // callback whose currentFrame is already beyond stopFrame.
        if (stopFrame >= 0 && bufferEndFrame >= stopFrame) {
            _captureArmed.store(false, std::memory_order_release);
        }
    }

    if (ioData && ioData->mNumberBuffers > 0 && ioData->mBuffers[0].mData) {
        auto *output = static_cast<Float32 *>(ioData->mBuffers[0].mData);
        const size_t outputSampleCount = static_cast<size_t>(inNumberFrames) * kOutputChannelCount;
        std::fill(output, output + outputSampleCount, 0.0f);

        if (!outputMuted) {
            for (const Track &track : _tracks) {
                const int64_t trackOffset = currentFrame - track.startFrame;
                if (trackOffset >= track.lengthFrames ||
                    trackOffset + static_cast<int64_t>(inNumberFrames) <= 0) {
                    continue;
                }
                for (UInt32 frame = 0; frame < inNumberFrames; ++frame) {
                    const int64_t sampleIndex = trackOffset + frame;
                    if (sampleIndex < 0 || sampleIndex >= track.lengthFrames) continue;
                    const float sample = track.samples[static_cast<size_t>(sampleIndex)];
                    output[frame * 2] += sample;
                    output[frame * 2 + 1] += sample;
                }
            }

            for (size_t index = 0; index < outputSampleCount; ++index) {
                if (output[index] > 1.0f || output[index] < -1.0f) {
                    output[index] = std::tanh(output[index]);
                }
            }
        }
    }

    _currentFrame.fetch_add(inNumberFrames, std::memory_order_release);
    return noErr;
}

@end
