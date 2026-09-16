#pragma once

#include "formats/crypto.hpp"
#include "install/engine.hpp"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <vector>

namespace nslib {

class CancelToken {
public:
    explicit CancelToken(std::atomic<bool>* flag = nullptr) : flag_(flag) {}
    bool requested() const { return flag_ && flag_->load(); }
    void check() const {
        if (requested()) throw InstallError("cancelled", "cancelled");
    }

private:
    std::atomic<bool>* flag_;
};

class ByteRing {
public:
    ByteRing(CancelToken cancel, size_t slotSize = 1 << 20, size_t slots = 8);

    void push(const uint8_t* p, size_t n, bool last);
    /** Returns false when the producer finished and the ring is empty. */
    bool pop(std::vector<uint8_t>& buf, size_t& n, bool& last);
    void abort(std::exception_ptr ep);
    void rethrowIfFailed();

private:
    struct Slot {
        std::vector<uint8_t> data;
        size_t n = 0;
        bool last = false;
    };
    std::vector<Slot> slots_;
    size_t slotSize_;
    size_t r_ = 0, w_ = 0, count_ = 0;
    bool done_ = false;
    std::exception_ptr err_;
    std::mutex mu_;
    std::condition_variable cv_;
    CancelToken cancel_;
};

struct PipelineStats {
    uint64_t ncaBytes = 0;
    std::array<uint8_t, 32> sha256{};
};

using ReadFn = std::function<void(const std::function<void(const uint8_t*, size_t)>& sink)>;
using WriteFn = std::function<void(uint64_t offset, const uint8_t* p, size_t n)>;
using ProgressFn = std::function<void(uint64_t done, uint64_t total)>;

/**
 * Three threads: reader (Range GET) → decoder (NCZ or passthrough + SHA) → writer.
 * `expectedNcaSize` is 0 when unknown. `maxWindow` is the zstd budget for NCZ.
 */
PipelineStats runPipeline(const ReadFn& readAll, const WriteFn& write, bool isNcz, uint64_t expectedNcaSize,
    CancelToken cancel, bool hash, uint64_t maxWindow, const ProgressFn& progress = {});

} // namespace nslib
