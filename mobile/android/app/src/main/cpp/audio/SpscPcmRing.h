#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace tapstory {

/**
 * Preallocated lock-free single-producer/single-consumer PCM ring.
 * `reset` must only be called while producer and consumer are quiescent.
 */
class SpscPcmRing {
public:
    explicit SpscPcmRing(size_t capacityFrames)
        : mStorage(std::max<size_t>(1, capacityFrames)) {}

    SpscPcmRing(const SpscPcmRing &) = delete;
    SpscPcmRing &operator=(const SpscPcmRing &) = delete;

    size_t capacity() const noexcept { return mStorage.size(); }

    size_t availableToRead() const noexcept {
        const uint64_t write = mWriteIndex.load(std::memory_order_acquire);
        const uint64_t read = mReadIndex.load(std::memory_order_acquire);
        return static_cast<size_t>(write - read);
    }

    size_t availableToWrite() const noexcept {
        return capacity() - availableToRead();
    }

    size_t write(const int16_t *source, size_t frameCount) noexcept {
        if (source == nullptr || frameCount == 0) return 0;

        const uint64_t write = mWriteIndex.load(std::memory_order_relaxed);
        const uint64_t read = mReadIndex.load(std::memory_order_acquire);
        const size_t writable = std::min(
                frameCount,
                capacity() - static_cast<size_t>(write - read));
        if (writable == 0) return 0;

        const size_t start = static_cast<size_t>(write % capacity());
        const size_t first = std::min(writable, capacity() - start);
        std::copy_n(source, first, mStorage.data() + start);
        std::copy_n(source + first, writable - first, mStorage.data());
        mWriteIndex.store(write + writable, std::memory_order_release);
        return writable;
    }

    template <typename Generator>
    size_t writeGenerated(size_t frameCount, Generator &&generator) noexcept {
        if (frameCount == 0) return 0;

        const uint64_t write = mWriteIndex.load(std::memory_order_relaxed);
        const uint64_t read = mReadIndex.load(std::memory_order_acquire);
        const size_t writable = std::min(
                frameCount,
                capacity() - static_cast<size_t>(write - read));
        if (writable == 0) return 0;

        const size_t start = static_cast<size_t>(write % capacity());
        const size_t first = std::min(writable, capacity() - start);
        for (size_t index = 0; index < first; ++index) {
            mStorage[start + index] = generator(index);
        }
        for (size_t index = first; index < writable; ++index) {
            mStorage[index - first] = generator(index);
        }
        mWriteIndex.store(write + writable, std::memory_order_release);
        return writable;
    }

    size_t read(int16_t *destination, size_t frameCount) noexcept {
        if (destination == nullptr || frameCount == 0) return 0;

        const uint64_t read = mReadIndex.load(std::memory_order_relaxed);
        const uint64_t write = mWriteIndex.load(std::memory_order_acquire);
        const size_t readable = std::min(frameCount, static_cast<size_t>(write - read));
        if (readable == 0) return 0;

        const size_t start = static_cast<size_t>(read % capacity());
        const size_t first = std::min(readable, capacity() - start);
        std::copy_n(mStorage.data() + start, first, destination);
        std::copy_n(mStorage.data(), readable - first, destination + first);
        mReadIndex.store(read + readable, std::memory_order_release);
        return readable;
    }

    void reset() noexcept {
        mReadIndex.store(0, std::memory_order_relaxed);
        mWriteIndex.store(0, std::memory_order_relaxed);
    }

private:
    std::vector<int16_t> mStorage;
    alignas(64) std::atomic<uint64_t> mWriteIndex{0};
    alignas(64) std::atomic<uint64_t> mReadIndex{0};
};

}  // namespace tapstory
