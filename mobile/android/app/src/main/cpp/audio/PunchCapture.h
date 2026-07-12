#pragma once

#include <algorithm>
#include <cstdint>
#include <limits>

namespace tapstory {

struct CaptureSlice {
    int32_t offsetFrames = 0;
    int32_t frameCount = 0;
    int64_t firstTimelineFrame = -1;
};

struct TailDrainSlice {
    int32_t timelineFrames = 0;
    int64_t remainingFrames = 0;
    bool complete = true;
};

constexpr int32_t kMaxClockDriftPartsPerMillion = 2'500;

inline int64_t compensatedPunchFrame(
        int64_t requestedPunchFrame,
        int64_t compensationFrames) noexcept {
    const int64_t requested = std::max<int64_t>(0, requestedPunchFrame);
    const int64_t compensation = std::max<int64_t>(0, compensationFrames);
    if (compensation > std::numeric_limits<int64_t>::max() - requested) {
        return std::numeric_limits<int64_t>::max();
    }
    return requested + compensation;
}

/**
 * Select the portion of an input callback that belongs in a recording.
 * Input and output use the same negotiated sample rate, so input frame zero is
 * associated with the callback's first timeline frame. Hardware latency is
 * reported separately and is deliberately not guessed here.
 */
inline CaptureSlice computeCaptureSlice(
        int64_t callbackTimelineFrame,
        int32_t availableInputFrames,
        int64_t punchTimelineFrame,
        bool captureAlreadyStarted) noexcept {
    if (availableInputFrames <= 0) return {};

    int32_t offset = 0;
    if (!captureAlreadyStarted) {
        const int64_t framesUntilPunch = punchTimelineFrame - callbackTimelineFrame;
        if (framesUntilPunch >= availableInputFrames) return {};
        offset = static_cast<int32_t>(std::max<int64_t>(0, framesUntilPunch));
    }

    return {
        offset,
        availableInputFrames - offset,
        callbackTimelineFrame + offset,
    };
}

inline bool isExactCaptureOnset(
        int64_t actualStartFrame,
        int64_t compensatedPunchFrame) noexcept {
    return actualStartFrame >= 0 && actualStartFrame == compensatedPunchFrame;
}

/**
 * Permit one device burst for callback quantization on short takes, then at
 * most 0.25% accumulated input/output clock-rate difference on longer takes.
 */
inline int64_t clockDriftFrameLimit(
        int64_t timelineFrames,
        int32_t framesPerBurst,
        int32_t maxPartsPerMillion = kMaxClockDriftPartsPerMillion) noexcept {
    constexpr int64_t partsPerMillion = 1'000'000;
    const int64_t timeline = std::max<int64_t>(0, timelineFrames);
    const int64_t burst = std::max<int64_t>(1, framesPerBurst);
    const int64_t ppm = std::max<int64_t>(0, std::min<int64_t>(
            partsPerMillion,
            maxPartsPerMillion));
    const int64_t whole = (timeline / partsPerMillion) * ppm;
    const int64_t remainder = timeline % partsPerMillion;
    const int64_t rateLimit = whole
            + (remainder * ppm + partsPerMillion - 1) / partsPerMillion;
    return std::max(burst, rateLimit);
}

inline bool isClockDriftWithinLimit(
        int64_t rawInputFrames,
        int64_t timelineFrames,
        int32_t framesPerBurst) noexcept {
    if (rawInputFrames < 0 || timelineFrames <= 0) return false;
    const int64_t difference = rawInputFrames >= timelineFrames
            ? rawInputFrames - timelineFrames
            : timelineFrames - rawInputFrames;
    return difference <= clockDriftFrameLimit(timelineFrames, framesPerBurst);
}

/** Select only the requested tail span from a potentially larger callback. */
inline TailDrainSlice computeTailDrainSlice(
        int64_t remainingTailFrames,
        int32_t callbackFrames) noexcept {
    const int64_t remaining = std::max<int64_t>(0, remainingTailFrames);
    const int32_t available = std::max(0, callbackFrames);
    const int32_t selected = static_cast<int32_t>(std::min<int64_t>(
            remaining,
            available));
    const int64_t nextRemaining = remaining - selected;
    return {selected, nextRemaining, nextRemaining == 0};
}

inline bool shouldDrainCaptureTail(
        bool captureArmed,
        int64_t actualCaptureStartFrame,
        bool captureStopRequested,
        int64_t compensationFrames) noexcept {
    return captureArmed
            && actualCaptureStartFrame >= 0
            && !captureStopRequested
            && compensationFrames > 0;
}

/** Return the number of new hardware discontinuities when counters exist. */
inline int32_t countNewXRuns(int32_t baseline, int32_t current) noexcept {
    if (baseline < 0 || current < 0) return -1;
    return std::max(0, current - baseline);
}

}  // namespace tapstory
