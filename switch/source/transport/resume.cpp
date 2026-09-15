#include "transport/resume.hpp"

#include <cctype>
#include <cstdint>
#include <exception>
#include <vector>

namespace nslib {
namespace {

std::vector<int> parts(const std::string& v) {
    std::vector<int> out;
    int cur = 0;
    bool any = false;
    for (char c : v) {
        if (std::isdigit(static_cast<unsigned char>(c))) {
            cur = cur * 10 + (c - '0');
            any = true;
        } else if (c == '.' && any) {
            out.push_back(cur);
            cur = 0;
            any = false;
        }
    }
    if (any) out.push_back(cur);
    while (out.size() < 3) out.push_back(0);
    return out;
}

} // namespace

int streamResuming(uint64_t offset, uint64_t length, const ByteSink& sink, const StreamAttempt& attempt,
    int maxAttempts, const RetryWait& wait)
{
    const bool bounded = length != UINT64_MAX;
    uint64_t done = 0;
    int lastStatus = 0;
    int failures = 0;
    for (;;) {
        const uint64_t start = offset + done;
        const uint64_t remain = bounded ? (length > done ? length - done : 0) : UINT64_MAX;
        if (bounded && remain == 0) return lastStatus == 0 ? 206 : lastStatus;
        uint64_t got = 0;
        std::exception_ptr sinkErr;
        try {
            lastStatus = attempt(start, remain, [&](const uint8_t* p, size_t n) {
                try {
                    sink(p, n);
                } catch (...) {
                    sinkErr = std::current_exception();
                    throw;
                }
                got += n;
                done += n;
            });
            if (bounded && done >= length) return lastStatus;
            // Nothing new: either the source ended or the server answered with an error status.
            if (got == 0) return lastStatus;
            // Unbounded request that finished cleanly.
            if (!bounded) return lastStatus;
            // The connection closed early without an error; resume from the new offset.
            failures = 0;
        } catch (const StreamFatal&) {
            if (sinkErr) std::rethrow_exception(sinkErr);
            throw;
        } catch (...) {
            if (sinkErr) std::rethrow_exception(sinkErr);
            failures = got > 0 ? 1 : failures + 1;
            if (failures >= maxAttempts) throw;
            if (wait) wait(failures);
        }
    }
}

long retryDelayMs(int failures) {
    if (failures < 1) failures = 1;
    long ms = 500;
    for (int i = 1; i < failures && ms < 8000; i++) ms *= 2;
    return ms > 8000 ? 8000 : ms;
}

bool rangeResponseOk(int status, uint64_t offset, uint64_t length) {
    if (status == 206) return true;
    if (status == 200) return offset == 0 && length == UINT64_MAX;
    return false;
}

int cmpVersion(const std::string& a, const std::string& b) {
    const auto pa = parts(a);
    const auto pb = parts(b);
    for (size_t i = 0; i < 3; i++) {
        if (pa[i] < pb[i]) return -1;
        if (pa[i] > pb[i]) return 1;
    }
    return 0;
}

} // namespace nslib
