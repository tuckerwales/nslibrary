#include "formats/crypto.hpp"
#include "formats/ncz.hpp"
#include "install/pipeline.hpp"
#include "test.hpp"

#include <algorithm>
#include <atomic>

using namespace nslib;

TEST(pipeline_passthrough_hashes) {
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    std::atomic<bool> cancel{false};
    std::vector<uint8_t> out;
    const auto stats = runPipeline(
        [&](const auto& sink) { sink(nca.data(), nca.size()); },
        [&](uint64_t, const uint8_t* p, size_t n) { out.insert(out.end(), p, p + n); },
        false, nca.size(), CancelToken(&cancel), true, kNczMaxOverrideWindow);
    CHECK(out == nca);
    CHECK_EQ(stats.ncaBytes, nca.size());
    const auto expect = sha256(nca.data(), nca.size());
    CHECK_EQ(hexLower(stats.sha256.data(), 32), hexLower(expect.data(), 32));
}

TEST(pipeline_ncz_matches_nca) {
    const auto ncz = slurpBytes(fixturePath("ncz-solid.bin"));
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    std::atomic<bool> cancel{false};
    std::vector<uint8_t> out;
    const auto stats = runPipeline(
        [&](const auto& sink) {
            // Odd chunk sizes to hit ring/decoder boundaries.
            size_t i = 0;
            while (i < ncz.size()) {
                const size_t n = std::min(size_t(17 + (i % 1000)), ncz.size() - i);
                sink(ncz.data() + i, n);
                i += n;
            }
        },
        [&](uint64_t, const uint8_t* p, size_t n) { out.insert(out.end(), p, p + n); },
        true, nca.size(), CancelToken(&cancel), true, kNczMaxOverrideWindow);
    CHECK(out == nca);
    CHECK_EQ(hexLower(stats.sha256.data(), 32), hexLower(sha256(nca.data(), nca.size()).data(), 32));
}

TEST(pipeline_cancel) {
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    std::atomic<bool> cancel{false};
    bool threw = false;
    try {
        runPipeline(
            [&](const auto& sink) {
                sink(nca.data(), 64);
                cancel = true;
                sink(nca.data() + 64, nca.size() - 64);
            },
            [&](uint64_t, const uint8_t*, size_t) {},
            false, nca.size(), CancelToken(&cancel), false, kNczMaxOverrideWindow);
    } catch (const InstallError& e) {
        threw = true;
        CHECK_EQ(e.result, std::string("cancelled"));
    }
    CHECK(threw);
}

TEST(pipeline_block_ncz) {
    const auto ncz = slurpBytes(fixturePath("ncz-block.bin"));
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    std::atomic<bool> cancel{false};
    std::vector<uint8_t> out;
    runPipeline(
        [&](const auto& sink) { sink(ncz.data(), ncz.size()); },
        [&](uint64_t, const uint8_t* p, size_t n) { out.insert(out.end(), p, p + n); },
        true, nca.size(), CancelToken(&cancel), false, kNczMaxOverrideWindow);
    CHECK(out == nca);
}
