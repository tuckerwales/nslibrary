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
    int maxAttempts)
{
    uint64_t done = 0;
    int lastStatus = 0;
    std::exception_ptr lastErr;
    for (int i = 0; i < maxAttempts; i++) {
        const uint64_t start = offset + done;
        const uint64_t remain = length == UINT64_MAX ? UINT64_MAX : (length > done ? length - done : 0);
        if (length != UINT64_MAX && remain == 0) return lastStatus == 0 ? 206 : lastStatus;
        uint64_t got = 0;
        try {
            lastStatus = attempt(start, remain, [&](const uint8_t* p, size_t n) {
                sink(p, n);
                got += n;
                done += n;
            });
            lastErr = nullptr;
            if (length != UINT64_MAX && done >= length) return lastStatus;
            if ((lastStatus == 200 || lastStatus == 206) && got == 0) return lastStatus;
            if (lastStatus != 200 && lastStatus != 206 && got == 0) return lastStatus;
        } catch (...) {
            lastErr = std::current_exception();
            if (got == 0 && i == maxAttempts - 1) std::rethrow_exception(lastErr);
        }
    }
    if (lastErr) std::rethrow_exception(lastErr);
    return lastStatus;
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
