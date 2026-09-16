#include "transport/resume.hpp"
#include "test.hpp"

#include <stdexcept>
#include <string>
#include <vector>

using namespace nslib;

TEST(resume_retries_after_partial_failure) {
    int attempts = 0;
    std::string got;
    const std::string payload = "abcdefghij";
    const int status = streamResuming(0, payload.size(),
        [&](const uint8_t* p, size_t n) { got.append(reinterpret_cast<const char*>(p), n); },
        [&](uint64_t off, uint64_t, const ByteSink& sink) {
            attempts++;
            if (attempts == 1) {
                sink(reinterpret_cast<const uint8_t*>(payload.data()) + off, 4);
                throw std::runtime_error("tcp drop");
            }
            sink(reinterpret_cast<const uint8_t*>(payload.data()) + off, size_t(payload.size() - off));
            return 206;
        });
    CHECK_EQ(status, 206);
    CHECK_EQ(attempts, 2);
    CHECK_EQ(got, payload);
}

TEST(resume_sd_full_preflight_is_not_retried_as_success) {
    bool threw = false;
    try {
        streamResuming(0, 10, [](const uint8_t*, size_t) {},
            [](uint64_t, uint64_t, const ByteSink&) -> int { throw std::runtime_error("boom"); }, 1);
    } catch (const std::runtime_error& e) {
        threw = std::string(e.what()) == "boom";
    }
    CHECK(threw);
}

TEST(cmp_version) {
    CHECK(cmpVersion("0.1.0", "0.1.0") == 0);
    CHECK(cmpVersion("0.1.0", "0.2.0") < 0);
    CHECK(cmpVersion("1.0.0", "0.9.9") > 0);
}
