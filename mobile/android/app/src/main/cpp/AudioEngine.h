#pragma once

#include <oboe/Oboe.h>
#include <vector>
#include <string>
#include <fstream>
#include <mutex>
#include <atomic>

struct Track {
    std::vector<float> data;
    int32_t startFrame;
    int32_t lengthFrames;
};

class AudioEngine : public oboe::AudioStreamCallback {
public:
    AudioEngine();
    ~AudioEngine();

    void start();
    void stop();
    void reset();  // Full reset - closes streams and resets frame counter
    
    // Call this once per track before playing
    void loadTrack(const std::string& trackId, const int16_t* data, int32_t numSamples, int32_t startFrame);
    
    // Clear all loaded tracks
    void clearTracks();
    
    // Start recording to a specific file path
    void startRecording(const std::string& filePath, int32_t startFrame);
    void stopRecording();
    
    // Get recording info after stopping
    int64_t getRecordingStartFrame() const { return mRecordStartFrame; }
    int64_t getRecordedSampleCount() const { return mRecordedSampleCount; }
    
    // Get current playback position in frames
    int64_t getCurrentFrame() const { return mCurrentFrame.load(); }
    
    // Seek to a specific frame position
    void seekToFrame(int64_t frame);

    // Oboe Callback - The Heartbeat of the system
    oboe::DataCallbackResult onAudioReady(
        oboe::AudioStream *oboeStream,
        void *audioData,
        int32_t numFrames) override;

    // Error handling
    void onErrorAfterClose(oboe::AudioStream *oboeStream, oboe::Result result) override;

private:
    std::shared_ptr<oboe::AudioStream> mPlayStream;
    std::shared_ptr<oboe::AudioStream> mRecordStream;

    std::vector<Track> mTracks;
    std::mutex mTrackMutex; // Thread safety for adding tracks

    // Recording State
    std::atomic<bool> mIsRecording { false };
    std::ofstream mRecordingFile;
    int32_t mRecordStartFrame = 0;
    std::atomic<int64_t> mRecordedSampleCount { 0 };
    
    // Current playback position
    std::atomic<int64_t> mCurrentFrame { 0 };
    
    // Stream state
    std::atomic<bool> mIsRunning { false };
    
    void openStreams();
    void closeStreams();
};

