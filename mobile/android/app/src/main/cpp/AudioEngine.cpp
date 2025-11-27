#include "AudioEngine.h"
#include <android/log.h>
#include <algorithm>
#include <cmath>

#define TAG "TapStoryAudio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

constexpr int32_t kSampleRate = 44100;
constexpr int32_t kChannelCountOut = 2;  // Stereo output
constexpr int32_t kChannelCountIn = 1;   // Mono input

AudioEngine::AudioEngine() {
    LOGI("AudioEngine created");
}

AudioEngine::~AudioEngine() {
    stop();
    LOGI("AudioEngine destroyed");
}

void AudioEngine::start() {
    if (mIsRunning.load()) {
        LOGW("AudioEngine already running");
        return;
    }
    
    LOGI("Starting AudioEngine at frame %lld", static_cast<long long>(mCurrentFrame.load()));
    
    // Only open streams if they don't exist
    if (!mPlayStream || mPlayStream->getState() == oboe::StreamState::Closed) {
        openStreams();
    }
    
    // Start mic first to warm up
    if (mRecordStream) {
        auto state = mRecordStream->getState();
        if (state == oboe::StreamState::Stopped || state == oboe::StreamState::Open) {
            oboe::Result result = mRecordStream->start();
            if (result != oboe::Result::OK) {
                LOGE("Failed to start record stream: %s", oboe::convertToText(result));
            }
        }
    }
    
    // Start speaker (drives the callback)
    if (mPlayStream) {
        auto state = mPlayStream->getState();
        if (state == oboe::StreamState::Stopped || state == oboe::StreamState::Open) {
            oboe::Result result = mPlayStream->start();
            if (result != oboe::Result::OK) {
                LOGE("Failed to start play stream: %s", oboe::convertToText(result));
            } else {
                mIsRunning.store(true);
                LOGI("AudioEngine started successfully at frame %lld", static_cast<long long>(mCurrentFrame.load()));
            }
        }
    }
}

void AudioEngine::stop() {
    if (!mIsRunning.load()) {
        return;
    }
    
    LOGI("Stopping AudioEngine");
    mIsRunning.store(false);
    
    // Just stop the streams, don't close them
    // This allows quick restart without recreating streams
    if (mPlayStream) {
        mPlayStream->stop();
    }
    if (mRecordStream) {
        mRecordStream->stop();
    }
    
    // DON'T reset frame counter here - let seekToFrame handle positioning
    // mCurrentFrame.store(0);  // REMOVED - was causing sync issues on replay
    
    LOGI("AudioEngine stopped (streams paused, not closed)");
}

void AudioEngine::reset() {
    LOGI("Resetting AudioEngine");
    mIsRunning.store(false);
    
    if (mPlayStream) {
        mPlayStream->stop();
    }
    if (mRecordStream) {
        mRecordStream->stop();
    }
    
    closeStreams();
    mCurrentFrame.store(0);
    LOGI("AudioEngine reset complete");
}

void AudioEngine::openStreams() {
    oboe::AudioStreamBuilder builder;
    
    // 1. Setup Playback Stream (The Master Clock)
    builder.setDirection(oboe::Direction::Output)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
        ->setSharingMode(oboe::SharingMode::Exclusive)
        ->setFormat(oboe::AudioFormat::Float)
        ->setChannelCount(kChannelCountOut)
        ->setSampleRate(kSampleRate)
        ->setDataCallback(this)
        ->setErrorCallback(this);
        
    oboe::Result result = builder.openStream(mPlayStream);
    if (result != oboe::Result::OK) {
        LOGE("Failed to open play stream: %s", oboe::convertToText(result));
        return;
    }
    
    LOGI("Play stream opened: sampleRate=%d, channelCount=%d, format=%d, framesPerBurst=%d",
         mPlayStream->getSampleRate(),
         mPlayStream->getChannelCount(),
         static_cast<int>(mPlayStream->getFormat()),
         mPlayStream->getFramesPerBurst());

    // 2. Setup Recording Stream (Slave - no callback, we read manually)
    oboe::AudioStreamBuilder recBuilder;
    recBuilder.setDirection(oboe::Direction::Input)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
        ->setSharingMode(oboe::SharingMode::Exclusive)
        ->setFormat(oboe::AudioFormat::I16)  // Record in 16-bit to save space
        ->setChannelCount(kChannelCountIn)
        ->setSampleRate(kSampleRate)
        ->setInputPreset(oboe::InputPreset::VoicePerformance);
        // NO CALLBACK - We read from this stream manually inside the output callback

    result = recBuilder.openStream(mRecordStream);
    if (result != oboe::Result::OK) {
        LOGE("Failed to open record stream: %s", oboe::convertToText(result));
        // Continue without recording capability
    } else {
        LOGI("Record stream opened: sampleRate=%d, channelCount=%d",
             mRecordStream->getSampleRate(),
             mRecordStream->getChannelCount());
    }
}

void AudioEngine::closeStreams() {
    if (mPlayStream) {
        mPlayStream->close();
        mPlayStream.reset();
    }
    if (mRecordStream) {
        mRecordStream->close();
        mRecordStream.reset();
    }
}

void AudioEngine::loadTrack(const std::string& trackId, const int16_t* data, int32_t numSamples, int32_t startFrame) {
    std::lock_guard<std::mutex> lock(mTrackMutex);
    
    Track track;
    track.startFrame = startFrame;
    track.lengthFrames = numSamples;  // Assuming mono source
    track.data.resize(numSamples);

    // Convert Short (Int16) to Float for high-quality mixing
    // Oboe/Audio standard: Int16 range is -32768 to 32767. Float range is -1.0 to 1.0
    const float scalar = 1.0f / 32768.0f;
    for (int32_t i = 0; i < numSamples; ++i) {
        track.data[i] = static_cast<float>(data[i]) * scalar;
    }
    
    mTracks.push_back(std::move(track));
    LOGI("Loaded track '%s': %d samples, startFrame=%d", trackId.c_str(), numSamples, startFrame);
}

void AudioEngine::clearTracks() {
    std::lock_guard<std::mutex> lock(mTrackMutex);
    mTracks.clear();
    LOGI("Cleared all tracks");
}

void AudioEngine::startRecording(const std::string& filePath, int32_t startFrame) {
    mRecordStartFrame = startFrame;
    mRecordedSampleCount.store(0);
    mRecordingFile.open(filePath, std::ios::binary);
    
    if (mRecordingFile.is_open()) {
        mIsRecording.store(true);
        LOGI("Recording started: path=%s, startFrame=%d", filePath.c_str(), startFrame);
    } else {
        LOGE("Failed to open recording file: %s", filePath.c_str());
    }
}

void AudioEngine::stopRecording() {
    mIsRecording.store(false);
    
    if (mRecordingFile.is_open()) {
        mRecordingFile.close();
        LOGI("Recording stopped: %lld samples captured", static_cast<long long>(mRecordedSampleCount.load()));
    }
}

void AudioEngine::seekToFrame(int64_t frame) {
    LOGI("Seeking to frame %lld (%.2f seconds)", 
         static_cast<long long>(frame), 
         static_cast<double>(frame) / kSampleRate);
    mCurrentFrame.store(frame);
}

// THIS IS THE CRITICAL SYNC LOOP
oboe::DataCallbackResult AudioEngine::onAudioReady(
        oboe::AudioStream *oboeStream,
        void *audioData,
        int32_t numFrames) {
        
    auto *outputBuffer = static_cast<float*>(audioData);
    int64_t currentFrame = mCurrentFrame.load();

    // ---------------------------------------------------------
    // 1. RECORDING (Input) - Read from mic synchronously
    // ---------------------------------------------------------
    if (mRecordStream && mRecordStream->getState() == oboe::StreamState::Started) {
        // Create a temp buffer for mic data (heap allocation to avoid VLA)
        std::vector<int16_t> inputBuffer(numFrames);
        
        // Read from mic using NON-BLOCKING read (timeout = 0)
        // Since we are in the high-priority audio thread, we grab what's ready.
        auto readResult = mRecordStream->read(inputBuffer.data(), numFrames, 0);
        
        if (readResult.value() > 0 && mIsRecording.load() && mRecordingFile.is_open()) {
            // Only write if currentFrame >= recordStartFrame
            if (currentFrame >= mRecordStartFrame) {
                mRecordingFile.write(reinterpret_cast<const char*>(inputBuffer.data()), 
                                     readResult.value() * sizeof(int16_t));
                mRecordedSampleCount.fetch_add(readResult.value());
            }
        }
    }

    // ---------------------------------------------------------
    // 2. MIXING (Output)
    // ---------------------------------------------------------
    // Clear buffer (Silence) - stereo interleaved
    std::fill(outputBuffer, outputBuffer + (numFrames * kChannelCountOut), 0.0f);

    {
        std::lock_guard<std::mutex> lock(mTrackMutex);
        
        for (const auto& track : mTracks) {
            // Calculate overlap between current buffer window and track
            int64_t trackOffset = currentFrame - track.startFrame;
            
            // If track is playing in this window
            if (trackOffset < track.lengthFrames && (trackOffset + numFrames) > 0) {
                for (int32_t i = 0; i < numFrames; ++i) {
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
    
    // Soft clipping to prevent harsh distortion
    for (int32_t i = 0; i < numFrames * kChannelCountOut; ++i) {
        float sample = outputBuffer[i];
        // Soft clip using tanh for samples exceeding [-1, 1]
        if (sample > 1.0f || sample < -1.0f) {
            outputBuffer[i] = std::tanh(sample);
        }
    }

    mCurrentFrame.fetch_add(numFrames);
    return oboe::DataCallbackResult::Continue;
}

void AudioEngine::onErrorAfterClose(oboe::AudioStream *oboeStream, oboe::Result result) {
    LOGE("Audio stream error: %s", oboe::convertToText(result));
    
    if (result == oboe::Result::ErrorDisconnected) {
        // Handle headphones unplugged or device change
        LOGW("Audio device disconnected, stopping engine");
        mIsRunning.store(false);
    }
}

