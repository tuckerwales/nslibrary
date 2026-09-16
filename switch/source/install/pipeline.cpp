#include "install/pipeline.hpp"

#include "formats/ncz.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

namespace nslib {
namespace {

class RingSeq : public SeqSource {
public:
    explicit RingSeq(ByteRing& ring) : ring_(&ring) {}

    size_t read(void* dst, size_t n) override {
        auto* out = static_cast<uint8_t*>(dst);
        size_t got = 0;
        while (got < n) {
            if (pos_ >= curN_) {
                if (eof_ || !ring_->pop(cur_, curN_, last_)) {
                    eof_ = true;
                    break;
                }
                pos_ = 0;
                if (last_ && curN_ == 0) {
                    eof_ = true;
                    break;
                }
            }
            const size_t take = std::min(n - got, curN_ - pos_);
            std::memcpy(out + got, cur_.data() + pos_, take);
            pos_ += take;
            got += take;
            if (last_ && pos_ >= curN_) {
                eof_ = true;
                break;
            }
        }
        return got;
    }

private:
    ByteRing* ring_;
    std::vector<uint8_t> cur_;
    size_t curN_ = 0;
    size_t pos_ = 0;
    bool last_ = false;
    bool eof_ = false;
};

} // namespace

ByteRing::ByteRing(CancelToken cancel, size_t slotSize, size_t slots)
    : slots_(slots), slotSize_(slotSize), cancel_(cancel)
{
    for (auto& s : slots_) s.data.resize(slotSize_);
}

void ByteRing::push(const uint8_t* p, size_t n, bool last) {
    size_t off = 0;
    do {
        const size_t take = n ? std::min(n - off, slotSize_) : 0;
        const bool slotLast = last && off + take == n;
        std::unique_lock<std::mutex> lock(mu_);
        while (count_ >= slots_.size() && !err_) {
            cancel_.check();
            cv_.wait_for(lock, std::chrono::milliseconds(50));
        }
        cancel_.check();
        if (err_) std::rethrow_exception(err_);
        Slot& s = slots_[w_];
        if (take) std::memcpy(s.data.data(), p + off, take);
        s.n = take;
        s.last = slotLast;
        w_ = (w_ + 1) % slots_.size();
        count_++;
        if (slotLast) done_ = true;
        cv_.notify_all();
        off += take;
        if (n == 0) break;
    } while (off < n);
}

bool ByteRing::pop(std::vector<uint8_t>& buf, size_t& n, bool& last) {
    std::unique_lock<std::mutex> lock(mu_);
    while (count_ == 0 && !done_ && !err_) {
        cancel_.check();
        cv_.wait_for(lock, std::chrono::milliseconds(50));
    }
    cancel_.check();
    if (err_) std::rethrow_exception(err_);
    if (count_ == 0) return false;
    Slot& s = slots_[r_];
    buf.resize(s.n);
    if (s.n) std::memcpy(buf.data(), s.data.data(), s.n);
    n = s.n;
    last = s.last;
    r_ = (r_ + 1) % slots_.size();
    count_--;
    cv_.notify_all();
    return true;
}

void ByteRing::abort(std::exception_ptr ep) {
    std::lock_guard<std::mutex> lock(mu_);
    if (!err_) err_ = std::move(ep);
    cv_.notify_all();
}

void ByteRing::rethrowIfFailed() {
    std::lock_guard<std::mutex> lock(mu_);
    if (err_) std::rethrow_exception(err_);
}

PipelineStats runPipeline(const ReadFn& readAll, const WriteFn& write, bool isNcz, uint64_t expectedNcaSize,
    CancelToken cancel, bool hash, uint64_t maxWindow, const ProgressFn& progress)
{
    ByteRing compressed(cancel, 1 << 20, 8);
    ByteRing plain(cancel, 1 << 20, 8);
    std::exception_ptr fail;
    std::mutex failMu;
    auto capture = [&](std::exception_ptr ep) {
        std::lock_guard<std::mutex> lock(failMu);
        if (!fail) fail = ep;
        compressed.abort(ep);
        plain.abort(ep);
    };

    auto runReader = [&] {
        try {
            readAll([&](const uint8_t* p, size_t n) {
                cancel.check();
                compressed.push(p, n, false);
            });
            compressed.push(nullptr, 0, true);
        } catch (...) {
            capture(std::current_exception());
        }
    };

    std::thread decoder([&] {
        try {
            RingSeq seq(compressed);
            auto emit = [&](const uint8_t* p, size_t n) { plain.push(p, n, false); };
            if (isNcz) {
                decodeNcz(seq, emit, maxWindow);
            } else {
                std::vector<uint8_t> buf;
                size_t n = 0;
                bool last = false;
                while (compressed.pop(buf, n, last)) {
                    if (n) emit(buf.data(), n);
                    if (last) break;
                }
            }
            plain.push(nullptr, 0, true);
        } catch (...) {
            capture(std::current_exception());
        }
    });

    PipelineStats stats;
    Sha256 sha;
    std::thread writer([&] {
        try {
            std::vector<uint8_t> buf;
            size_t n = 0;
            bool last = false;
            while (plain.pop(buf, n, last)) {
                cancel.check();
                if (n) {
                    write(stats.ncaBytes, buf.data(), n);
                    if (hash) sha.update(buf.data(), n);
                    stats.ncaBytes += n;
                    if (progress) progress(stats.ncaBytes, expectedNcaSize);
                }
                if (last) break;
            }
        } catch (...) {
            capture(std::current_exception());
        }
    });

#ifdef __SWITCH__
    // libcurl/mbedTLS on Switch is not safe off the main thread. The HTTP Range
    // GET (readAll) must run here; decode/write stay on worker threads.
    runReader();
#else
    std::thread reader(runReader);
    reader.join();
#endif
    decoder.join();
    writer.join();
    if (fail) std::rethrow_exception(fail);
    if (hash) stats.sha256 = sha.digest();
    return stats;
}

} // namespace nslib
