#include "api/json.hpp"
#include "formats/crypto.hpp"
#include "formats/pfs0.hpp"
#include "test.hpp"

#include <algorithm>

using namespace nslib;

TEST(hfs0_golden_round_trip) {
    const auto bytes = slurpBytes(fixturePath("hfs0.bin"));
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    MemoryReader reader(bytes);
    const Hfs0Partition p = parseHfs0(reader);
    CHECK_EQ(p.entries.size(), expect["hfs0"]["names"].size());
    for (size_t i = 0; i < p.entries.size(); i++) {
        CHECK_EQ(p.entries[i].name, expect["hfs0"]["names"][i].asString());
        CHECK_EQ(std::string(entryKindName(p.entries[i].kind)), expect["hfs0"]["kinds"][i].asString());
        CHECK_EQ(p.entries[i].size, expect["hfs0"]["sizes"][i].asUint());
        const uint32_t hashed = uint32_t(std::min(uint64_t(expect["hfs0"]["hashedSize"].asUint()), p.entries[i].size));
        CHECK_EQ(p.entries[i].hashedSize, hashed);
        const auto slice = reader.readExact(p.entries[i].offset, size_t(p.entries[i].hashedSize));
        const auto hash = sha256(slice.data(), slice.size());
        CHECK_EQ(hexLower(p.entries[i].sha256, 32), hexLower(hash.data(), 32));
    }
}

TEST(hfs0_bad_magic) {
    auto bytes = slurpBytes(fixturePath("pfs0.bin"));
    bool threw = false;
    try {
        parseHfs0(MemoryReader(bytes));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_MAGIC"));
    }
    CHECK(threw);
}

TEST(hfs0_builder_matches_parser) {
    std::vector<NamedBytes> files = {{"a.cnmt.nca", {1, 2, 3}}, {"b.ncz", {9}}};
    const auto buf = buildHfs0(files, 0x20, 0x10);
    const Hfs0Partition p = parseHfs0(MemoryReader(buf));
    CHECK_EQ(p.entries.size(), 2u);
    CHECK(p.entries[0].kind == EntryKind::Cnmt);
    CHECK(p.entries[1].kind == EntryKind::Ncz);
}
