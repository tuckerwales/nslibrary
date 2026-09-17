// Guards against malformed or hostile input from the library server and from container headers.
// Everything here used to crash, hang, or throw away good data on the console.
#include "api/json.hpp"
#include "api/protocol.hpp"
#include "api/url.hpp"
#include "formats/crypto.hpp"
#include "formats/ncz.hpp"
#include "formats/pfs0.hpp"
#include "install/pipeline.hpp"
#include "test.hpp"

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include <zstd.h>

using namespace nslib;

namespace {

bool throwsJsonError(const std::string& text) {
    try {
        Json::parse(text);
        return false;
    } catch (const JsonError&) {
        return true;
    }
}

/** A PFS0 with one entry whose offset/size are written verbatim, so tests can wrap them. */
std::vector<uint8_t> pfs0WithEntry(uint64_t offset, uint64_t size) {
    const std::string name = "abc.nca";
    const uint32_t table = uint32_t(name.size() + 1);
    std::vector<uint8_t> out(0x10 + 0x18 + table, 0);
    std::memcpy(out.data(), "PFS0", 4);
    writeU32(out.data() + 4, 1);
    writeU32(out.data() + 8, table);
    writeU64(out.data() + 0x10, offset);
    writeU64(out.data() + 0x18, size);
    writeU32(out.data() + 0x20, 0);
    std::memcpy(out.data() + 0x28, name.data(), name.size());
    out.resize(out.size() + 64, 0);
    return out;
}

} // namespace

TEST(json_rejects_deep_nesting_instead_of_overflowing_the_stack) {
    // 200k open brackets: without a depth cap this recurses until the console's stack runs out.
    std::string deep(200000, '[');
    CHECK(throwsJsonError(deep));

    std::string deepObjects;
    for (int i = 0; i < 100000; i++) deepObjects += "{\"a\":";
    CHECK(throwsJsonError(deepObjects));

    // Nesting the device API actually uses still parses.
    const Json ok = Json::parse(R"({"apps":[{"u":[[1,2,3,"nsp"]]}]})");
    CHECK_EQ(ok["apps"][0]["u"][0][3].asString(), std::string("nsp"));
}

TEST(json_decodes_surrogate_pairs_and_rejects_bad_numbers) {
    // "\ud83c\udfae" is U+1F3AE GAME CONTROLLER; a title name carrying one must survive.
    const Json v = Json::parse("\"a\\ud83c\\udfaeb\"");
    CHECK_EQ(v.asString(), std::string("a\xf0\x9f\x8e\xae" "b"));

    // A lone high surrogate has no UTF-8 form; it becomes U+FFFD rather than invalid bytes.
    const Json lone = Json::parse("\"\\ud83c\"");
    CHECK_EQ(lone.asString(), std::string("\xef\xbf\xbd"));

    // std::stod throws out_of_range here; callers only ever catch JsonError.
    CHECK(throwsJsonError("1e999999"));
}

TEST(json_never_dumps_a_non_finite_number) {
    const std::string nan = Json::number(std::nan("")).dump();
    CHECK(nan.find("nan") == std::string::npos);
    CHECK(nan.find("inf") == std::string::npos);
    CHECK_EQ(Json::number(1.0 / 0.0).dump(), std::string("0"));
}

TEST(pfs0_entry_offsets_cannot_wrap_past_the_end) {
    // offset + size wraps to 0, which a plain `offset + size > end` check waves through.
    const auto wrapping = pfs0WithEntry(UINT64_MAX - 0x20, 0x21 + 0x1f);
    MemoryReader reader(wrapping);
    bool threw = false;
    try {
        parsePfs0(reader);
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TRUNCATED"));
    }
    CHECK(threw);

    // A well-formed entry still parses.
    const auto sane = pfs0WithEntry(0, 8);
    MemoryReader ok(sane);
    const auto part = parsePfs0(ok);
    CHECK_EQ(part.entries.size(), size_t(1));
    CHECK_EQ(part.entries[0].size, uint64_t(8));
}

TEST(memory_reader_bounds_check_survives_an_overflowing_offset) {
    std::vector<uint8_t> buf(16, 0);
    MemoryReader reader(buf);
    uint8_t dst[8]{};
    bool threw = false;
    try {
        reader.read(UINT64_MAX - 3, dst, 8);
    } catch (const FormatError&) {
        threw = true;
    }
    CHECK(threw);
    CHECK(rangeFits(0, 16, 16));
    CHECK(!rangeFits(8, 16, 16));
    CHECK(!rangeFits(UINT64_MAX, 1, 16));
}

TEST(ncz_rejects_an_impossible_block_count) {
    // blockCount 0x40000001 * 4 wraps to 4 in 32-bit arithmetic, so the size table is read short
    // and then indexed for a billion entries.
    std::vector<uint8_t> ncz(size_t(kNczPrefixSize) + 0x10 + 0x40 + 0x18 + 16, 0);
    uint8_t* table = ncz.data() + kNczPrefixSize;
    std::memcpy(table, "NCZSECTN", 8);
    writeU64(table + 8, 1);
    uint8_t* section = table + 0x10;
    writeU64(section, kNczPrefixSize);
    writeU64(section + 8, 0x1000);
    writeU64(section + 0x10, uint64_t(NczCryptoType::None));
    uint8_t* block = section + 0x40;
    std::memcpy(block, "NCZBLOCK", 8);
    block[0x0b] = 14;
    writeU32(block + 0x0c, 0x40000001u);
    writeU64(block + 0x10, 0x40000001ull << 14);

    MemoryReader reader(ncz);
    bool threw = false;
    try {
        parseNczHeader(reader);
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("INVALID"));
    }
    CHECK(threw);
}

TEST(ncz_restores_a_patch_with_hundreds_of_sections) {
    // BKTR patch NCAs split into thousands of AES-CTR sections (8711 in a Witcher 3 update); the
    // parser once capped them at 64. Entries are written out of order to exercise the sort.
    const size_t count = 300;
    std::vector<NczSection> sections;
    uint64_t offset = kNczPrefixSize;
    for (size_t i = 0; i < count; i++) {
        NczSection s{};
        s.offset = offset;
        s.size = 0x101 + i;
        s.cryptoType = uint64_t(i % 3 == 1 ? NczCryptoType::None : NczCryptoType::Ctr);
        for (int k = 0; k < 16; k++) s.cryptoKey[k] = uint8_t(i * 7 + k);
        for (int k = 0; k < 8; k++) s.cryptoCounter[k] = uint8_t(i * 13 + k);
        sections.push_back(s);
        offset += s.size;
    }
    std::vector<uint8_t> plain(static_cast<size_t>(offset));
    for (size_t i = 0; i < plain.size(); i++) plain[i] = uint8_t((i * 31) ^ (i >> 9));
    std::vector<uint8_t> nca = plain;
    for (const auto& s : sections) {
        if (s.cryptoType == uint64_t(NczCryptoType::Ctr)) {
            aesCtrXor(s.cryptoKey, s.cryptoCounter, s.offset, nca.data() + s.offset, size_t(s.size));
        }
    }

    std::vector<uint8_t> ncz(nca.begin(), nca.begin() + kNczPrefixSize);
    std::vector<uint8_t> table(0x10 + count * 0x40, 0);
    std::memcpy(table.data(), "NCZSECTN", 8);
    writeU64(table.data() + 8, count);
    for (size_t i = 0; i < count; i++) {
        const NczSection& s = sections[count - 1 - i];
        uint8_t* e = table.data() + 0x10 + i * 0x40;
        writeU64(e, s.offset);
        writeU64(e + 8, s.size);
        writeU64(e + 0x10, s.cryptoType);
        std::memcpy(e + 0x20, s.cryptoKey, 16);
        std::memcpy(e + 0x30, s.cryptoCounter, 16);
    }
    ncz.insert(ncz.end(), table.begin(), table.end());
    const size_t bodyN = plain.size() - kNczPrefixSize;
    std::vector<uint8_t> frame(ZSTD_compressBound(bodyN));
    const size_t z = ZSTD_compress(frame.data(), frame.size(), plain.data() + kNczPrefixSize, bodyN, 3);
    CHECK(!ZSTD_isError(z));
    ncz.insert(ncz.end(), frame.begin(), frame.begin() + z);

    MemoryReader reader(ncz);
    const NczHeader h = parseNczHeader(reader);
    CHECK_EQ(h.sections.size(), count);
    CHECK_EQ(nczOutputSize(h), uint64_t(nca.size()));
    CHECK(decompressNczToBuffer(reader) == nca);
}

TEST(ncz_rejects_a_section_table_longer_than_the_file) {
    std::vector<uint8_t> ncz(size_t(kNczPrefixSize) + 0x10 + 0x40, 0);
    std::memcpy(ncz.data() + kNczPrefixSize, "NCZSECTN", 8);
    writeU64(ncz.data() + kNczPrefixSize + 8, 1000);
    MemoryReader reader(ncz);
    bool threw = false;
    try {
        parseNczHeader(reader);
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("INVALID"));
    }
    CHECK(threw);
}

TEST(catalog_keeps_the_titles_it_can_read) {
    const auto res = parseCatalog(R"({
        "rev": 7,
        "full": true,
        "apps": [
            {"i": "0100000000000000", "n": "Good One"},
            {"i": 42, "n": "Bad id"},
            {"i": "0100000000000001", "n": "Good Two", "b": [1, 2, "not a size", "nsp"]},
            {"i": "0100000000000002", "n": "Good Three"}
        ],
        "del": ["0100000000000009", 5]
    })");
    CHECK_EQ(res.rev, int64_t(7));
    CHECK_EQ(res.apps.size(), size_t(2));
    CHECK_EQ(res.skipped, size_t(2));
    CHECK_EQ(res.apps[0].name, std::string("Good One"));
    CHECK_EQ(res.apps[1].name, std::string("Good Three"));
    CHECK_EQ(res.del.size(), size_t(1));
}

TEST(catalog_and_progress_tolerate_missing_optional_fields) {
    const auto res = parseCatalog(R"({"rev": 3, "apps": []})");
    CHECK_EQ(res.full, false);
    CHECK_EQ(res.rev, int64_t(3));

    const auto p = parseJobProgress(R"({"phase":"content","done":1,"total":2})");
    CHECK_EQ(p.bps, 0.0);
    CHECK_EQ(p.phase, std::string("content"));
}

TEST(discovery_rejects_an_out_of_range_port) {
    bool threw = false;
    try {
        parseDiscoveryReply(R"({"serverId":"a","name":"b","port":70000,"proto":1})");
    } catch (const JsonError&) {
        threw = true;
    }
    CHECK(threw);
    const auto ok = parseDiscoveryReply(R"({"serverId":"a","name":"b","port":8465,"proto":1})");
    CHECK_EQ(ok.port, 8465);
}

TEST(query_values_from_the_server_are_percent_encoded) {
    CHECK_EQ(percentEncode("0100ABCD"), std::string("0100ABCD"));
    CHECK_EQ(percentEncode("a b&c=d"), std::string("a%20b%26c%3Dd"));
    CHECK_EQ(percentEncode("../../switch"), std::string("..%2F..%2Fswitch"));
    CHECK_EQ(queryString({{"cursor", "12&wait=99"}}), std::string("?cursor=12%26wait%3D99"));
}

TEST(pipeline_reports_a_sink_failure_without_terminating) {
    // The writer throws part-way through: both workers must unwind and the error must surface.
    std::atomic<bool> cancel{false};
    std::vector<uint8_t> src(4 << 20, 0x5a);
    bool threw = false;
    try {
        runPipeline(
            [&](const std::function<void(const uint8_t*, size_t)>& sink) { sink(src.data(), src.size()); },
            [](uint64_t off, const uint8_t*, size_t) {
                if (off > (1 << 20)) throw std::runtime_error("SD card full");
            },
            false, src.size(), CancelToken(&cancel), true, kNczMaxOverrideWindow);
    } catch (const std::exception& e) {
        threw = true;
        CHECK_EQ(std::string(e.what()), std::string("SD card full"));
    }
    CHECK(threw);
}
