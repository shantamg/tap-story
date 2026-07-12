#pragma once

#include <oboe/FullDuplexStream.h>
#include <oboe/Oboe.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "audio/PunchCapture.h"
#include "audio/SpscPcmRing.h"

struct Track {
    std::vector<float> data;
    int64_t startFrame = 0;
    int64_t lengthFrames = 0;
};

/**
 * Low-latency duplex engine.
 *
 * Oboe FullDuplexStream owns the input/output warmup and buffering policy. The
 * realtime callback only mixes already-decoded tracks and copies captured PCM
 * into a lock-free SPSC ring. File I/O is isolated on mWriterThread.
 */
class AudioEngine final : public oboe::FullDuplexStream,
                          public oboe::AudioStreamErrorCallback {
public:
    AudioEngine();
    ~AudioEngine() override;

    bool prepare();
    bool startSession();
    void stopPlayback();
    void reset();

    bool loadTrack(
            const std::string &trackId,
            const int16_t *data,
            int32_t numFrames,
            int64_t startFrame);
    bool clearTracks();

    bool startRecording(const std::string &filePath, int64_t punchFrame);
    void stopRecording();
    void setLatencyCompensationFrames(int64_t frames) {
        mLatencyCompensationFrames.store(
                std::max<int64_t>(0, frames),
                std::memory_order_release);
    }
    void invalidateAudioRoute();

    int64_t getRecordingStartFrame() const {
        return mActualRecordingStartFrame.load(std::memory_order_acquire);
    }
    int64_t getRecordingEndFrame() const {
        return mRecordingEndFrame.load(std::memory_order_acquire);
    }
    int64_t getRequestedPunchFrame() const {
        return mRequestedPunchFrame.load(std::memory_order_acquire);
    }
    int64_t getLatencyCompensationFrames() const {
        return mLatencyCompensationFrames.load(std::memory_order_acquire);
    }
    int64_t getRecordedSampleCount() const {
        return mRecordedSampleCount.load(std::memory_order_acquire);
    }
    int64_t getDroppedCaptureFrameCount() const {
        return mDroppedCaptureFrames.load(std::memory_order_acquire);
    }
    int64_t getShortInputFrameCount() const {
        return mShortInputFrames.load(std::memory_order_acquire);
    }
    bool isCaptureOnsetExact() const {
        return tapstory::isExactCaptureOnset(
                mActualRecordingStartFrame.load(std::memory_order_acquire),
                mPunchFrame.load(std::memory_order_acquire));
    }
    bool isCaptureClockDriftWithinBounds() const;
    int64_t getCaptureClockDriftFrameLimit() const;
    int32_t getInputXRunDelta() const;
    int32_t getOutputXRunDelta() const;
    int64_t getCurrentFrame() const {
        return mCurrentFrame.load(std::memory_order_acquire);
    }
    int32_t getSampleRate() const { return mSampleRate; }
    int32_t getInputFramesPerBurst() const;
    int32_t getOutputFramesPerBurst() const;
    int32_t getInputXRunCount() const;
    int32_t getOutputXRunCount() const;
    int32_t getInputPerformanceMode() const;
    int32_t getOutputPerformanceMode() const;
    int32_t getLastStreamError() const {
        return mLastStreamError.load(std::memory_order_acquire);
    }
    double getInputLatencyMillis();
    double getOutputLatencyMillis();

    void seekToFrame(int64_t frame);

    oboe::DataCallbackResult onBothStreamsReady(
            const void *inputData,
            int numInputFrames,
            void *outputData,
            int numOutputFrames) override;
    oboe::DataCallbackResult onAudioReady(
            oboe::AudioStream *audioStream,
            void *audioData,
            int32_t numFrames) override;

    void onErrorBeforeClose(oboe::AudioStream *stream, oboe::Result error) override;
    void onErrorAfterClose(oboe::AudioStream *stream, oboe::Result error) override;

private:
    static constexpr int32_t kOutputChannelCount = 2;
    static constexpr int32_t kInputChannelCount = 1;
    static constexpr int32_t kRecordingRingSeconds = 10;
    static constexpr size_t kWriterChunkFrames = 4096;

    bool openStreams();
    void closeStreams();
    void writerLoop();
    void finishCaptureAtFrame(int64_t endFrame);
    void finishCaptureAtCurrentFrame();
    void waitForRealtimeProducer();
    void refreshLatencyDiagnosticsLocked();

    std::shared_ptr<oboe::AudioStream> mPlayStream;
    std::shared_ptr<oboe::AudioStream> mRecordStream;

    // Mutated only while playback is fully stopped; callback reads without a lock.
    std::vector<Track> mTracks;
    std::mutex mControlMutex;

    std::unique_ptr<tapstory::SpscPcmRing> mRecordingRing;
    std::thread mWriterThread;
    std::ofstream mRecordingFile;
    std::atomic<bool> mWriterShouldStop{false};
    std::atomic<bool> mCaptureArmed{false};
    std::atomic<bool> mCaptureStopRequested{false};
    std::atomic<bool> mRealtimeProducerActive{false};
    std::atomic<int64_t> mPunchFrame{0};
    std::atomic<int64_t> mRequestedPunchFrame{0};
    std::atomic<int64_t> mLatencyCompensationFrames{0};
    std::atomic<int64_t> mActualRecordingStartFrame{-1};
    std::atomic<int64_t> mRecordingEndFrame{-1};
    std::atomic<int64_t> mRecordedSampleCount{0};
    std::atomic<int64_t> mDroppedCaptureFrames{0};
    std::atomic<int64_t> mShortInputFrames{0};
    std::atomic<int64_t> mTailDrainFramesRemaining{0};
    int32_t mInputXRunBaseline = -1;
    int32_t mOutputXRunBaseline = -1;

    std::atomic<int64_t> mCurrentFrame{0};
    std::atomic<bool> mIsRunning{false};
    std::atomic<int32_t> mLastStreamError{0};
    int32_t mSampleRate = 0;
    double mLastInputLatencyMillis = -1.0;
    double mLastOutputLatencyMillis = -1.0;
};
