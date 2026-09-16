#include "api/json.hpp"
#include "formats/pfs0.hpp"
#include "test.hpp"

using namespace nslib;

TEST(pfs0_golden_round_trip) {
    const auto bytes = slurpBytes(fixturePath("pfs0.bin"));
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    MemoryReader reader(bytes);
    const Partition p = parsePfs0(reader);

    CHECK_EQ(p.headerSize, expect["pfs0"]["headerSize"].asUint());
    CHECK_EQ(p.headerSize % 0x20, 0u);
    CHECK_EQ(p.entries.size(), expect["pfs0"]["names"].size());
    for (size_t i = 0; i < p.entries.size(); i++) {
        CHECK_EQ(p.entries[i].name, expect["pfs0"]["names"][i].asString());
        CHECK_EQ(std::string(entryKindName(p.entries[i].kind)), expect["pfs0"]["kinds"][i].asString());
        CHECK_EQ(p.entries[i].size, expect["pfs0"]["sizes"][i].asUint());
        const auto slice = reader.readExact(p.entries[i].offset, size_t(p.entries[i].size));
        CHECK_EQ(slice.size(), size_t(p.entries[i].size));
    }
}

TEST(pfs0_empty) {
    const auto bytes = slurpBytes(fixturePath("empty.pfs0.bin"));
    const Partition p = parsePfs0(MemoryReader(bytes));
    CHECK(p.entries.empty());
    CHECK_EQ(p.headerSize % 0x20, 0u);
}

TEST(pfs0_bad_magic) {
    auto bytes = slurpBytes(fixturePath("pfs0.bin"));
    bytes[0] = 'X';
    bool threw = false;
    try {
        parsePfs0(MemoryReader(bytes));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_MAGIC"));
    }
    CHECK(threw);
}

TEST(pfs0_truncated) {
    const auto bytes = slurpBytes(fixturePath("pfs0.bin"));
    bool threw = false;
    try {
        auto cut = bytes;
        cut.pop_back();
        parsePfs0(MemoryReader(cut));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TRUNCATED"));
    }
    CHECK(threw);

    threw = false;
    try {
        parsePfs0(MemoryReader(bytes.data(), 0x20));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TRUNCATED"));
    }
    CHECK(threw);
}

TEST(pfs0_classify) {
    CHECK(classifyEntry("abc.cnmt.nca") == EntryKind::Cnmt);
    CHECK(classifyEntry("ABC.CNMT.NCA") == EntryKind::Cnmt);
    CHECK(classifyEntry("deadbeef.nca") == EntryKind::Nca);
    CHECK(classifyEntry("deadbeef.ncz") == EntryKind::Ncz);
    CHECK(classifyEntry("id.tik") == EntryKind::Tik);
    CHECK(classifyEntry("id.cert") == EntryKind::Cert);
    CHECK(classifyEntry("readme.txt") == EntryKind::Other);
}

TEST(pfs0_builder_matches_parser) {
    std::vector<NamedBytes> files = {
        {"a.cnmt.nca", {1, 2, 3}},
        {"b.nca", {}},
        {"c.tik", {9, 9}},
    };
    const auto buf = buildPfs0(files);
    const Partition p = parsePfs0(MemoryReader(buf));
    CHECK_EQ(p.entries.size(), 3u);
    CHECK_EQ(p.entries[0].name, std::string("a.cnmt.nca"));
    CHECK(p.entries[0].kind == EntryKind::Cnmt);
    CHECK_EQ(p.entries[1].size, 0u);
    CHECK(p.entries[2].kind == EntryKind::Tik);
}
