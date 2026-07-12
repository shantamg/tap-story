#include "AudioEngine.h"

#include <android/log.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <thread>

#define TAG "TapStoryAudio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

int32_t xRunCount(const std::shared_ptr<oboe::AudioStream> &stream) {
    if (!stream) return -1;
    const auto result = stream->getXRunCount();
    return result ? result.value() : -1;
}

double latencyMillis(const std::shared_ptr<oboe::AudioStream> &stream) {
    if (!stream || stream->getState() != oboe::StreamState::Started) return -1.0;
    const auto result = stream->calculateLatencyMillis();
    return result ? result.value() : -1.0;
}

}  // namespace

AudioEngine::AudioEngine() {
    LOGI("AudioEngine created");
}

AudioEngine::~AudioEngine() {
    stopPlayback();
    stopRecording();
    std::lock_guard<std::mutex> lock(mControlMutex);
    closeStreams();
    LOGI("AudioEngine destroyed");
}

bool AudioEngine::prepare() {
    std::lock_guard<std::mutex> lock(mControlMutex);
    if (mCaptureArmed.load(std::memory_order_acquire) || mWriterThread.joinable()) {
        LOGE("Refusing to recreate streams while a capture is active");
        return false;
    }
    if (mLastStreamError.load(std::memory_order_acquire) != 0) {
        LOGE("Failed engine must be deleted before streams are prepared again");
        return false;
    }
    if (mPlayStream && mRecordStream
        && mPlayStream->getState() != oboe::StreamState::Closed
        && mPlayStream->getState() != oboe::StreamState::Disconnected
        && mRecordStream->getState() != oboe::StreamState::Closed
        && mRecordStream->getState() != oboe::StreamState::Disconnected) {
        return true;
    }
    return openStreams();
}

bool AudioEngine::openStreams() {
    closeStreams();

    oboe::AudioStreamBuilder outputBuilder;
    outputBuilder.setDirection(oboe::Direction::Output)
            ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
            ->setSharingMode(oboe::SharingMode::Exclusive)
            ->setFormat(oboe::AudioFormat::Float)
            ->setFormatConversionAllowed(true)
            ->setChannelCount(kOutputChannelCount)
            ->setUsage(oboe::Usage::Media)
            ->setContentType(oboe::ContentType::Music)
            ->setDataCallback(this)
            ->setErrorCallback(this);

    oboe::Result result = outputBuilder.openStream(mPlayStream);
    if (result != oboe::Result::OK || !mPlayStream) {
        LOGE("Failed to open output stream: %s", oboe::convertToText(result));
        closeStreams();
        return false;
    }

    // The output is opened first without forcing a rate. Its granted rate is
    // then requested for input, as required by Oboe FullDuplexStream.
    mSampleRate = mPlayStream->getSampleRate();
    if (mSampleRate <= 0) {
        LOGE("Output stream returned invalid sample rate: %d", mSampleRate);
        closeStreams();
        return false;
    }

    oboe::AudioStreamBuilder inputBuilder;
    inputBuilder.setDirection(oboe::Direction::Input)
            ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
            ->setSharingMode(oboe::SharingMode::Exclusive)
            ->setFormat(oboe::AudioFormat::Float)
            ->setFormatConversionAllowed(true)
            ->setChannelCount(kInputChannelCount)
            ->setSampleRate(mSampleRate)
            ->setBufferCapacityInFrames(mPlayStream->getBufferCapacityInFrames() * 2)
            ->setInputPreset(oboe::InputPreset::VoiceRecognition);

    result = inputBuilder.openStream(mRecordStream);
    if (result != oboe::Result::OK || !mRecordStream) {
        LOGE("Failed to open input stream: %s", oboe::convertToText(result));
        closeStreams();
        return false;
    }

    if (mRecordStream->getSampleRate() != mSampleRate) {
        LOGE("Duplex rate mismatch: output=%d, input=%d",
             mSampleRate,
             mRecordStream->getSampleRate());
        closeStreams();
        return false;
    }

    setOutputStream(mPlayStream.get());
    setInputStream(mRecordStream.get());
    // Keep one input burst between the application and DSP cursors. Oboe
    // recommends zero for latency benchmarks but one for glitch resilience.
    // calculateLatencyMillis() measures from the stream read position, so this
    // buffered burst is already included in the input-latency diagnostic and
    // therefore in the externally applied round-trip compensation.
    setNumInputBurstsCushion(1);
    setMinimumFramesBeforeRead(0);

    mRecordingRing = std::make_unique<tapstory::SpscPcmRing>(
            static_cast<size_t>(mSampleRate) * kRecordingRingSeconds);
    mLastStreamError.store(0, std::memory_order_release);

    LOGI("Duplex streams prepared: rate=%d, outputBurst=%d, inputBurst=%d, "
         "outputMode=%d, inputMode=%d",
         mSampleRate,
         mPlayStream->getFramesPerBurst(),
         mRecordStream->getFramesPerBurst(),
         static_cast<int>(mPlayStream->getPerformanceMode()),
         static_cast<int>(mRecordStream->getPerformanceMode()));
    return true;
}

void AudioEngine::closeStreams() {
    // Output must close first so its callback can no longer read input.
    if (mPlayStream) {
        mPlayStream->stop();
        mPlayStream->close();
        mPlayStream.reset();
    }
    setOutputStream(nullptr);

    if (mRecordStream) {
        mRecordStream->stop();
        mRecordStream->close();
        mRecordStream.reset();
    }
    setInputStream(nullptr);
    mSampleRate = 0;
    mLastInputLatencyMillis = -1.0;
    mLastOutputLatencyMillis = -1.0;
}

bool AudioEngine::startSession() {
    std::lock_guard<std::mutex> lock(mControlMutex);
    if (mIsRunning.load(std::memory_order_acquire)) return true;
    if (mLastStreamError.load(std::memory_order_acquire) != 0) {
        LOGE("Audio engine has failed; reinitialize it before restart");
        return false;
    }
    const bool streamsUsable = mPlayStream && mRecordStream
            && mPlayStream->getState() != oboe::StreamState::Closed
            && mPlayStream->getState() != oboe::StreamState::Disconnected
            && mRecordStream->getState() != oboe::StreamState::Closed
            && mRecordStream->getState() != oboe::StreamState::Disconnected;
    if (!streamsUsable) {
        LOGE("Duplex streams are no longer usable; cleanup and reinitialize the engine");
        return false;
    }

    // Publish running before requesting the asynchronous starts so an immediate
    // error callback cannot be overwritten with a stale true value afterward.
    mIsRunning.store(true, std::memory_order_release);
    const oboe::Result result = oboe::FullDuplexStream::start();
    if (result != oboe::Result::OK) {
        LOGE("Failed to start duplex streams: %s", oboe::convertToText(result));
        mLastStreamError.store(static_cast<int32_t>(result), std::memory_order_release);
        oboe::FullDuplexStream::stop();
        if (mPlayStream) mPlayStream->stop();
        if (mRecordStream) mRecordStream->stop();
        mIsRunning.store(false, std::memory_order_release);
        waitForRealtimeProducer();
        return false;
    }
    if (mLastStreamError.load(std::memory_order_acquire) != 0
        || !mIsRunning.load(std::memory_order_acquire)) {
        oboe::FullDuplexStream::stop();
        if (mPlayStream) mPlayStream->stop();
        if (mRecordStream) mRecordStream->stop();
        mIsRunning.store(false, std::memory_order_release);
        waitForRealtimeProducer();
        return false;
    }
    LOGI("AudioEngine started at timeline frame %lld",
         static_cast<long long>(mCurrentFrame.load(std::memory_order_acquire)));
    return true;
}

void AudioEngine::refreshLatencyDiagnosticsLocked() {
    const double input = latencyMillis(mRecordStream);
    const double output = latencyMillis(mPlayStream);
    if (input >= 0.0) mLastInputLatencyMillis = input;
    if (output >= 0.0) mLastOutputLatencyMillis = output;
}

void AudioEngine::stopPlayback() {
    std::unique_lock<std::mutex> lock(mControlMutex);
    const bool captureArmedAtStop = mCaptureArmed.load(std::memory_order_acquire);
    const int64_t captureStartAtStop = mActualRecordingStartFrame.load(
            std::memory_order_acquire);
    const bool cancelPendingCapture = captureArmedAtStop && captureStartAtStop < 0;
    const bool shouldDrainTail = mIsRunning.load(std::memory_order_acquire)
            && tapstory::shouldDrainCaptureTail(
                    captureArmedAtStop,
                    captureStartAtStop,
                    mCaptureStopRequested.load(std::memory_order_acquire),
                    mLatencyCompensationFrames.load(std::memory_order_acquire));
    if (shouldDrainTail) {
        const int64_t tailFrames = mLatencyCompensationFrames.load(std::memory_order_acquire);
        mTailDrainFramesRemaining.store(tailFrames, std::memory_order_release);
        const int64_t tailMillis = mSampleRate > 0
                ? (tailFrames * 1'000 + mSampleRate - 1) / mSampleRate
                : 0;
        const auto timeoutMillis = std::max<int64_t>(500, tailMillis * 2 + 250);
        const auto deadline = std::chrono::steady_clock::now()
                + std::chrono::milliseconds(timeoutMillis);
        while (mCaptureArmed.load(std::memory_order_acquire)
               && mTailDrainFramesRemaining.load(std::memory_order_acquire) > 0
               && mLastStreamError.load(std::memory_order_acquire) == 0
               && std::chrono::steady_clock::now() < deadline) {
            lock.unlock();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            lock.lock();
        }
        if (mCaptureArmed.load(std::memory_order_acquire)
            && mTailDrainFramesRemaining.load(std::memory_order_acquire) > 0
            && mLastStreamError.load(std::memory_order_acquire) == 0) {
            LOGE("Timed out while draining %lld compensated tail frames",
                 static_cast<long long>(
                         mTailDrainFramesRemaining.load(std::memory_order_acquire)));
            mLastStreamError.store(-1004, std::memory_order_release);
            mCaptureStopRequested.store(true, std::memory_order_release);
        }
    }
    if (captureArmedAtStop && !shouldDrainTail) {
        mCaptureStopRequested.store(true, std::memory_order_release);
    }

    if (mIsRunning.load(std::memory_order_acquire)) refreshLatencyDiagnosticsLocked();
    oboe::FullDuplexStream::stop();
    // FullDuplexStream requests an asynchronous stop. Blocking here ensures
    // control-thread track mutation cannot race the realtime callback.
    if (mPlayStream) mPlayStream->stop();
    if (mRecordStream) mRecordStream->stop();
    mIsRunning.store(false, std::memory_order_release);
    waitForRealtimeProducer();
    if (mCaptureArmed.load(std::memory_order_acquire)) {
        finishCaptureAtCurrentFrame();
    }
    if (cancelPendingCapture) {
        // Stop won the control-thread race with the first accepted input frame.
        // Even if an in-flight callback copied PCM, preserve pre-punch cancel
        // semantics by making finalization return NO_RECORDING.
        mActualRecordingStartFrame.store(-1, std::memory_order_release);
    }
    LOGI("AudioEngine playback stopped at timeline frame %lld",
         static_cast<long long>(mCurrentFrame.load(std::memory_order_acquire)));
}

void AudioEngine::reset() {
    stopPlayback();
    stopRecording();
    std::lock_guard<std::mutex> lock(mControlMutex);
    closeStreams();
    mCurrentFrame.store(0, std::memory_order_release);
}

bool AudioEngine::loadTrack(
        const std::string &trackId,
        const int16_t *data,
        int32_t numFrames,
        int64_t startFrame) {
    if (data == nullptr || numFrames <= 0) return false;
    std::lock_guard<std::mutex> lock(mControlMutex);
    if (mIsRunning.load(std::memory_order_acquire)) {
        LOGE("Refusing to mutate tracks while audio is running");
        return false;
    }

    Track track;
    track.startFrame = startFrame;
    track.lengthFrames = numFrames;
    track.data.resize(static_cast<size_t>(numFrames));
    constexpr float scalar = 1.0f / 32768.0f;
    for (int32_t frame = 0; frame < numFrames; ++frame) {
        track.data[static_cast<size_t>(frame)] = static_cast<float>(data[frame]) * scalar;
    }
    mTracks.push_back(std::move(track));
    LOGI("Loaded mono track '%s': %d frames, startFrame=%lld",
         trackId.c_str(),
         numFrames,
         static_cast<long long>(startFrame));
    return true;
}

bool AudioEngine::clearTracks() {
    std::lock_guard<std::mutex> lock(mControlMutex);
    if (mIsRunning.load(std::memory_order_acquire)) {
        LOGE("Refusing to clear tracks while audio is running");
        return false;
    }
    mTracks.clear();
    return true;
}

bool AudioEngine::startRecording(const std::string &filePath, int64_t punchFrame) {
    stopRecording();
    std::lock_guard<std::mutex> lock(mControlMutex);
    if (!mRecordingRing || mSampleRate <= 0) {
        LOGE("Cannot record before duplex streams are prepared");
        return false;
    }
    if (mLastStreamError.load(std::memory_order_acquire) != 0) {
        LOGE("Cannot record after an audio stream or writer failure; reinitialize first");
        return false;
    }

    mRecordingRing->reset();
    mRecordingFile.clear();
    mRecordingFile.open(filePath, std::ios::binary | std::ios::trunc);
    if (!mRecordingFile.is_open()) {
        LOGE("Failed to open recording file: %s", filePath.c_str());
        return false;
    }

    const int64_t requestedPunchFrame = std::max<int64_t>(0, punchFrame);
    const int64_t compensatedPunchFrame = tapstory::compensatedPunchFrame(
            requestedPunchFrame,
            mLatencyCompensationFrames.load(std::memory_order_acquire));
    mRequestedPunchFrame.store(requestedPunchFrame, std::memory_order_release);
    mPunchFrame.store(compensatedPunchFrame, std::memory_order_release);
    mActualRecordingStartFrame.store(-1, std::memory_order_release);
    mRecordingEndFrame.store(-1, std::memory_order_release);
    mRecordedSampleCount.store(0, std::memory_order_release);
    mDroppedCaptureFrames.store(0, std::memory_order_release);
    mShortInputFrames.store(0, std::memory_order_release);
    mTailDrainFramesRemaining.store(0, std::memory_order_release);
    mInputXRunBaseline = getInputXRunCount();
    mOutputXRunBaseline = getOutputXRunCount();
    mWriterShouldStop.store(false, std::memory_order_release);
    mCaptureStopRequested.store(false, std::memory_order_release);
    mWriterThread = std::thread(&AudioEngine::writerLoop, this);
    mCaptureArmed.store(true, std::memory_order_release);
    LOGI("Recording armed: requestedPunch=%lld, compensatedGate=%lld, compensationFrames=%lld",
         static_cast<long long>(requestedPunchFrame),
         static_cast<long long>(compensatedPunchFrame),
         static_cast<long long>(mLatencyCompensationFrames.load(std::memory_order_acquire)));
    return true;
}

void AudioEngine::finishCaptureAtFrame(int64_t endFrame) {
    mRecordingEndFrame.store(endFrame, std::memory_order_release);
    mCaptureArmed.store(false, std::memory_order_release);
    mCaptureStopRequested.store(false, std::memory_order_release);
    mTailDrainFramesRemaining.store(0, std::memory_order_release);
}

void AudioEngine::finishCaptureAtCurrentFrame() {
    finishCaptureAtFrame(mCurrentFrame.load(std::memory_order_acquire));
}

void AudioEngine::waitForRealtimeProducer() {
    while (mRealtimeProducerActive.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
}

void AudioEngine::stopRecording() {
    std::unique_lock<std::mutex> lock(mControlMutex);
    const bool hasWriter = mWriterThread.joinable();
    if (!hasWriter && !mCaptureArmed.load(std::memory_order_acquire)) return;

    mCaptureStopRequested.store(true, std::memory_order_release);
    if (!mIsRunning.load(std::memory_order_acquire)) {
        if (mCaptureArmed.load(std::memory_order_acquire)) {
            finishCaptureAtCurrentFrame();
        }
    } else {
        // Stop on the next output callback boundary. If the stream has failed
        // and no callback arrives, fall back to the last completed frame.
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
        while (mCaptureArmed.load(std::memory_order_acquire)
               && std::chrono::steady_clock::now() < deadline) {
            lock.unlock();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            lock.lock();
        }
        if (mCaptureArmed.load(std::memory_order_acquire)) {
            finishCaptureAtCurrentFrame();
        }
    }

    waitForRealtimeProducer();
    mWriterShouldStop.store(true, std::memory_order_release);
    lock.unlock();
    if (mWriterThread.joinable()) mWriterThread.join();
    lock.lock();

    if (mRecordingFile.is_open()) {
        mRecordingFile.flush();
        if (!mRecordingFile.good()) {
            mLastStreamError.store(-1001, std::memory_order_release);
        }
        mRecordingFile.close();
        if (mRecordingFile.fail()) {
            mLastStreamError.store(-1001, std::memory_order_release);
        }
    }
    LOGI("Recording finalized: requestedPunch=%lld, actualFirstFrame=%lld, endFrame=%lld, "
         "rawFrames=%lld, dropped=%lld, shortInput=%lld, driftLimit=%lld, "
         "inputXRuns=%d, outputXRuns=%d",
         static_cast<long long>(mRequestedPunchFrame.load(std::memory_order_acquire)),
         static_cast<long long>(mActualRecordingStartFrame.load(std::memory_order_acquire)),
         static_cast<long long>(mRecordingEndFrame.load(std::memory_order_acquire)),
         static_cast<long long>(mRecordedSampleCount.load(std::memory_order_acquire)),
         static_cast<long long>(mDroppedCaptureFrames.load(std::memory_order_acquire)),
         static_cast<long long>(mShortInputFrames.load(std::memory_order_acquire)),
         static_cast<long long>(getCaptureClockDriftFrameLimit()),
         getInputXRunDelta(),
         getOutputXRunDelta());
}

void AudioEngine::writerLoop() {
    std::array<int16_t, kWriterChunkFrames> buffer{};
    for (;;) {
        const size_t framesRead = mRecordingRing
                ? mRecordingRing->read(buffer.data(), buffer.size())
                : 0;
        if (framesRead > 0) {
            mRecordingFile.write(
                    reinterpret_cast<const char *>(buffer.data()),
                    static_cast<std::streamsize>(framesRead * sizeof(int16_t)));
            if (!mRecordingFile.good()) {
                mLastStreamError.store(-1001, std::memory_order_release);
                mWriterShouldStop.store(true, std::memory_order_release);
                mCaptureStopRequested.store(true, std::memory_order_release);
            } else {
                mRecordedSampleCount.fetch_add(
                        static_cast<int64_t>(framesRead),
                        std::memory_order_release);
            }
            continue;
        }

        if (mWriterShouldStop.load(std::memory_order_acquire)
            && (!mRecordingRing || mRecordingRing->availableToRead() == 0)) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
}

oboe::DataCallbackResult AudioEngine::onAudioReady(
        oboe::AudioStream *audioStream,
        void *audioData,
        int32_t numFrames) {
    const oboe::DataCallbackResult result = oboe::FullDuplexStream::onAudioReady(
            audioStream,
            audioData,
            numFrames);
    if (result == oboe::DataCallbackResult::Stop) {
        int32_t noError = 0;
        mLastStreamError.compare_exchange_strong(
                noError,
                -1002,
                std::memory_order_release,
                std::memory_order_relaxed);
        mCaptureStopRequested.store(true, std::memory_order_release);
        mIsRunning.store(false, std::memory_order_release);
    }
    return result;
}

void AudioEngine::seekToFrame(int64_t frame) {
    mCurrentFrame.store(std::max<int64_t>(0, frame), std::memory_order_release);
}

void AudioEngine::invalidateAudioRoute() {
    mLastStreamError.store(-1003, std::memory_order_release);
    mCaptureStopRequested.store(true, std::memory_order_release);
    stopPlayback();
}

oboe::DataCallbackResult AudioEngine::onBothStreamsReady(
        const void *inputData,
        int numInputFrames,
        void *outputData,
        int numOutputFrames) {
    mRealtimeProducerActive.store(true, std::memory_order_release);

    auto *output = static_cast<float *>(outputData);
    const int64_t callbackFrame = mCurrentFrame.load(std::memory_order_relaxed);
    const int32_t outputFrames = std::max(0, numOutputFrames);
    const int64_t remainingTailFrames = mTailDrainFramesRemaining.load(
            std::memory_order_acquire);
    const bool isTailDrain = remainingTailFrames > 0;
    const bool captureStopRequested = mCaptureStopRequested.load(
            std::memory_order_acquire);
    const int32_t availableInputFrames = inputData == nullptr
            ? 0
            : std::max(0, numInputFrames);
    const tapstory::TailDrainSlice tailSlice = isTailDrain
            ? tapstory::computeTailDrainSlice(remainingTailFrames, availableInputFrames)
            : tapstory::TailDrainSlice{outputFrames, 0, false};
    const int32_t timelineFrames = tailSlice.timelineFrames;

    std::fill_n(
            output,
            static_cast<size_t>(outputFrames) * kOutputChannelCount,
            0.0f);

    if (!isTailDrain) {
        for (const Track &track : mTracks) {
            const int64_t trackOffset = callbackFrame - track.startFrame;
            if (trackOffset >= track.lengthFrames || trackOffset + outputFrames <= 0) continue;

            for (int32_t frame = 0; frame < outputFrames; ++frame) {
                const int64_t sampleIndex = trackOffset + frame;
                if (sampleIndex < 0 || sampleIndex >= track.lengthFrames) continue;
                const float sample = track.data[static_cast<size_t>(sampleIndex)];
                output[frame * 2] += sample;
                output[frame * 2 + 1] += sample;
            }
        }
    }

    for (int32_t sample = 0; sample < outputFrames * kOutputChannelCount; ++sample) {
        output[sample] = std::max(-1.0f, std::min(1.0f, output[sample]));
    }

    bool captureStopped = false;
    if (captureStopRequested) {
        finishCaptureAtCurrentFrame();
        captureStopped = true;
    } else if (mCaptureArmed.load(std::memory_order_acquire) && mRecordingRing) {
        const int32_t alignedInputFrames = inputData == nullptr
                ? 0
                : std::min(availableInputFrames, timelineFrames);
        const bool started = mActualRecordingStartFrame.load(std::memory_order_acquire) >= 0;
        const int64_t punchFrame = mPunchFrame.load(std::memory_order_acquire);
        const tapstory::CaptureSlice expectedSlice = tapstory::computeCaptureSlice(
                callbackFrame,
                timelineFrames,
                punchFrame,
                started);
        const tapstory::CaptureSlice slice = tapstory::computeCaptureSlice(
                callbackFrame,
                alignedInputFrames,
                punchFrame,
                started);
        if (slice.frameCount < expectedSlice.frameCount) {
            mShortInputFrames.fetch_add(
                    expectedSlice.frameCount - slice.frameCount,
                    std::memory_order_release);
        }

        if (slice.frameCount > 0 && inputData != nullptr) {
            const auto *input = static_cast<const float *>(inputData) + slice.offsetFrames;
            const size_t written = mRecordingRing->writeGenerated(
                    static_cast<size_t>(slice.frameCount),
                    [input](size_t index) noexcept {
                        const float value = std::max(-1.0f, std::min(1.0f, input[index]));
                        return static_cast<int16_t>(value * 32767.0f);
                    });

            if (written > 0 && !started) {
                mActualRecordingStartFrame.store(
                        slice.firstTimelineFrame,
                        std::memory_order_release);
            }
            if (written < static_cast<size_t>(slice.frameCount)) {
                mDroppedCaptureFrames.fetch_add(
                        static_cast<int64_t>(slice.frameCount - written),
                        std::memory_order_release);
            }
        }
    }

    const int64_t nextFrame = callbackFrame + timelineFrames;
    mCurrentFrame.store(nextFrame, std::memory_order_release);
    if (isTailDrain && !captureStopped) {
        mTailDrainFramesRemaining.store(tailSlice.remainingFrames, std::memory_order_release);
        if (tailSlice.complete) {
            finishCaptureAtFrame(nextFrame);
        }
    }
    mRealtimeProducerActive.store(false, std::memory_order_release);
    return oboe::DataCallbackResult::Continue;
}

void AudioEngine::onErrorBeforeClose(oboe::AudioStream *, oboe::Result error) {
    mLastStreamError.store(static_cast<int32_t>(error), std::memory_order_release);
    mCaptureStopRequested.store(true, std::memory_order_release);
    mIsRunning.store(false, std::memory_order_release);
}

void AudioEngine::onErrorAfterClose(oboe::AudioStream *, oboe::Result error) {
    mLastStreamError.store(static_cast<int32_t>(error), std::memory_order_release);
    mCaptureStopRequested.store(true, std::memory_order_release);
    mIsRunning.store(false, std::memory_order_release);
    if (getInputStream()) getInputStream()->requestStop();
}

int32_t AudioEngine::getInputFramesPerBurst() const {
    return mRecordStream ? mRecordStream->getFramesPerBurst() : 0;
}

int32_t AudioEngine::getOutputFramesPerBurst() const {
    return mPlayStream ? mPlayStream->getFramesPerBurst() : 0;
}

int32_t AudioEngine::getInputXRunCount() const {
    return xRunCount(mRecordStream);
}

int32_t AudioEngine::getOutputXRunCount() const {
    return xRunCount(mPlayStream);
}

int32_t AudioEngine::getInputXRunDelta() const {
    return tapstory::countNewXRuns(mInputXRunBaseline, getInputXRunCount());
}

int32_t AudioEngine::getOutputXRunDelta() const {
    return tapstory::countNewXRuns(mOutputXRunBaseline, getOutputXRunCount());
}

int64_t AudioEngine::getCaptureClockDriftFrameLimit() const {
    const int64_t timelineFrames = mRecordingEndFrame.load(std::memory_order_acquire)
            - mActualRecordingStartFrame.load(std::memory_order_acquire);
    const int32_t framesPerBurst = std::max(
            getInputFramesPerBurst(),
            getOutputFramesPerBurst());
    return tapstory::clockDriftFrameLimit(timelineFrames, framesPerBurst);
}

bool AudioEngine::isCaptureClockDriftWithinBounds() const {
    const int64_t timelineFrames = mRecordingEndFrame.load(std::memory_order_acquire)
            - mActualRecordingStartFrame.load(std::memory_order_acquire);
    const int32_t framesPerBurst = std::max(
            getInputFramesPerBurst(),
            getOutputFramesPerBurst());
    return tapstory::isClockDriftWithinLimit(
            mRecordedSampleCount.load(std::memory_order_acquire),
            timelineFrames,
            framesPerBurst);
}

int32_t AudioEngine::getInputPerformanceMode() const {
    return mRecordStream ? static_cast<int32_t>(mRecordStream->getPerformanceMode()) : -1;
}

int32_t AudioEngine::getOutputPerformanceMode() const {
    return mPlayStream ? static_cast<int32_t>(mPlayStream->getPerformanceMode()) : -1;
}

double AudioEngine::getInputLatencyMillis() {
    std::lock_guard<std::mutex> lock(mControlMutex);
    const double current = latencyMillis(mRecordStream);
    if (current >= 0.0) mLastInputLatencyMillis = current;
    return mLastInputLatencyMillis;
}

double AudioEngine::getOutputLatencyMillis() {
    std::lock_guard<std::mutex> lock(mControlMutex);
    const double current = latencyMillis(mPlayStream);
    if (current >= 0.0) mLastOutputLatencyMillis = current;
    return mLastOutputLatencyMillis;
}
