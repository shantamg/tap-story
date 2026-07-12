#include <atomic>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <thread>
#include <vector>

#include "audio/PunchCapture.h"
#include "audio/SpscPcmRing.h"

namespace {

void testPunchBeforeBufferCapturesWholeInput() {
    const auto slice = tapstory::computeCaptureSlice(1'000, 128, 900, false);
    assert(slice.offsetFrames == 0);
    assert(slice.frameCount == 128);
    assert(slice.firstTimelineFrame == 1'000);
}

void testPunchInsideBufferCapturesExactBoundary() {
    const auto slice = tapstory::computeCaptureSlice(1'000, 128, 1'063, false);
    assert(slice.offsetFrames == 63);
    assert(slice.frameCount == 65);
    assert(slice.firstTimelineFrame == 1'063);
}

void testCompensatedPunchGatesLaterButExactly() {
    const int64_t requestedPunch = 1'000;
    const int64_t compensatedPunch = tapstory::compensatedPunchFrame(requestedPunch, 240);
    assert(compensatedPunch == 1'240);
    const auto slice = tapstory::computeCaptureSlice(1'200, 128, compensatedPunch, false);
    assert(slice.offsetFrames == 40);
    assert(slice.frameCount == 88);
    assert(slice.firstTimelineFrame == 1'240);
}

void testPunchAfterAvailableInputCapturesNothing() {
    const auto slice = tapstory::computeCaptureSlice(1'000, 32, 1'063, false);
    assert(slice.offsetFrames == 0);
    assert(slice.frameCount == 0);
    assert(slice.firstTimelineFrame == -1);
}

void testStartedCaptureIgnoresPunch() {
    const auto slice = tapstory::computeCaptureSlice(1'000, 64, 10'000, true);
    assert(slice.offsetFrames == 0);
    assert(slice.frameCount == 64);
    assert(slice.firstTimelineFrame == 1'000);
}

void testCaptureOnsetMustMatchCompensatedPunch() {
    assert(tapstory::isExactCaptureOnset(1'240, 1'240));
    assert(!tapstory::isExactCaptureOnset(1'368, 1'240));
    assert(!tapstory::isExactCaptureOnset(-1, 1'240));
}

void testClockDriftAllowsOneBurstAndBoundedLongTakeRate() {
    constexpr int32_t burstFrames = 192;
    assert(tapstory::clockDriftFrameLimit(48'000, burstFrames) == burstFrames);
    assert(tapstory::isClockDriftWithinLimit(47'808, 48'000, burstFrames));
    assert(!tapstory::isClockDriftWithinLimit(47'807, 48'000, burstFrames));

    // Five minutes at 48 kHz permits 0.25% correction, but no more.
    constexpr int64_t fiveMinutes = 14'400'000;
    assert(tapstory::clockDriftFrameLimit(fiveMinutes, burstFrames) == 36'000);
    assert(tapstory::isClockDriftWithinLimit(
            fiveMinutes - 36'000,
            fiveMinutes,
            burstFrames));
    assert(!tapstory::isClockDriftWithinLimit(
            fiveMinutes - 36'001,
            fiveMinutes,
            burstFrames));
}

void testTailDrainUsesExactPartialFinalCallback() {
    const auto first = tapstory::computeTailDrainSlice(240, 128);
    assert(first.timelineFrames == 128);
    assert(first.remainingFrames == 112);
    assert(!first.complete);

    const auto final = tapstory::computeTailDrainSlice(first.remainingFrames, 128);
    assert(final.timelineFrames == 112);
    assert(final.remainingFrames == 0);
    assert(final.complete);

    // Advancing the capture end by the compensation preserves the logical span.
    constexpr int64_t logicalPunch = 1'000;
    constexpr int64_t compensation = 240;
    constexpr int64_t transportStop = 10'000;
    const int64_t actualStart = tapstory::compensatedPunchFrame(
            logicalPunch,
            compensation);
    const int64_t drainedEnd = transportStop + compensation;
    assert(drainedEnd - actualStart == transportStop - logicalPunch);
}

void testTailDrainWaitsForShortInputInsteadOfClippingIt() {
    const auto shortInput = tapstory::computeTailDrainSlice(240, 64);
    assert(shortInput.timelineFrames == 64);
    assert(shortInput.remainingFrames == 176);
    assert(!shortInput.complete);

    const auto nextInput = tapstory::computeTailDrainSlice(shortInput.remainingFrames, 192);
    assert(nextInput.timelineFrames == 176);
    assert(nextInput.remainingFrames == 0);
    assert(nextInput.complete);
}

void testTailDrainRequiresCaptureToHaveStarted() {
    assert(!tapstory::shouldDrainCaptureTail(true, -1, false, 240));
    assert(tapstory::shouldDrainCaptureTail(true, 1'240, false, 240));
    assert(!tapstory::shouldDrainCaptureTail(false, 1'240, false, 240));
    assert(!tapstory::shouldDrainCaptureTail(true, 1'240, true, 240));
    assert(!tapstory::shouldDrainCaptureTail(true, 1'240, false, 0));
}

void testXRunDeltaIgnoresUnsupportedCounters() {
    assert(tapstory::countNewXRuns(-1, -1) == -1);
    assert(tapstory::countNewXRuns(-1, 3) == -1);
    assert(tapstory::countNewXRuns(3, -1) == -1);
}

void testXRunDeltaCountsNewDiscontinuities() {
    assert(tapstory::countNewXRuns(4, 7) == 3);
    assert(tapstory::countNewXRuns(4, 4) == 0);
    assert(tapstory::countNewXRuns(4, 2) == 0);
}

void testRingWrapAndCapacity() {
    tapstory::SpscPcmRing ring(5);
    const int16_t first[] = {1, 2, 3, 4};
    assert(ring.write(first, 4) == 4);
    assert(ring.availableToRead() == 4);

    int16_t out[5] = {};
    assert(ring.read(out, 2) == 2);
    assert(out[0] == 1 && out[1] == 2);

    const int16_t second[] = {5, 6, 7, 8};
    assert(ring.write(second, 4) == 3);
    assert(ring.availableToRead() == 5);
    assert(ring.read(out, 5) == 5);
    const int16_t expected[] = {3, 4, 5, 6, 7};
    for (int i = 0; i < 5; ++i) assert(out[i] == expected[i]);
}

void testRingGeneratedWrite() {
    tapstory::SpscPcmRing ring(4);
    assert(ring.writeGenerated(3, [](size_t index) {
        return static_cast<int16_t>(10 + index);
    }) == 3);
    int16_t output[3] = {};
    assert(ring.read(output, 3) == 3);
    assert(output[0] == 10 && output[1] == 11 && output[2] == 12);
}

void testRingSingleProducerSingleConsumer() {
    constexpr int kCount = 200'000;
    tapstory::SpscPcmRing ring(257);
    std::atomic<bool> producerDone{false};
    std::vector<int16_t> received;
    received.reserve(kCount);

    std::thread producer([&] {
        for (int value = 0; value < kCount;) {
            const int16_t sample = static_cast<int16_t>(value % 30'000);
            if (ring.write(&sample, 1) == 1) ++value;
        }
        producerDone.store(true, std::memory_order_release);
    });

    while (!producerDone.load(std::memory_order_acquire) || ring.availableToRead() > 0) {
        int16_t sample = 0;
        if (ring.read(&sample, 1) == 1) received.push_back(sample);
    }
    producer.join();

    assert(received.size() == kCount);
    for (int i = 0; i < kCount; ++i) {
        assert(received[i] == static_cast<int16_t>(i % 30'000));
    }
}

}  // namespace

int main() {
    testPunchBeforeBufferCapturesWholeInput();
    testPunchInsideBufferCapturesExactBoundary();
    testCompensatedPunchGatesLaterButExactly();
    testPunchAfterAvailableInputCapturesNothing();
    testStartedCaptureIgnoresPunch();
    testCaptureOnsetMustMatchCompensatedPunch();
    testClockDriftAllowsOneBurstAndBoundedLongTakeRate();
    testTailDrainUsesExactPartialFinalCallback();
    testTailDrainWaitsForShortInputInsteadOfClippingIt();
    testTailDrainRequiresCaptureToHaveStarted();
    testXRunDeltaIgnoresUnsupportedCounters();
    testXRunDeltaCountsNewDiscontinuities();
    testRingWrapAndCapacity();
    testRingGeneratedWrite();
    testRingSingleProducerSingleConsumer();
    std::cout << "AudioCoreTests passed\n";
    return 0;
}
