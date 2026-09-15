#include "api/json.hpp"
#include "formats/cnmt.hpp"
#include "formats/pfs0.hpp"
#include "test.hpp"

using namespace nslib;

TEST(cnmt_golden) {
    const auto bytes = slurpBytes(fixturePath("cnmt.bin"));
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    const CnmtInfo info = parseCnmt(bytes);
    CHECK_EQ(info.titleId, expect["titleId"].asString());
    CHECK_EQ(info.version, uint32_t(expect["version"].asUint()));
    CHECK_EQ(std::string(packagedKindName(info.kind)), expect["kind"].asString());
    CHECK_EQ(info.applicationId, expect["applicationId"].asString());
    CHECK(info.hasRequiredSystemVersion);
    CHECK_EQ(info.requiredSystemVersion, uint32_t(expect["requiredSystemVersion"].asUint()));
    CHECK_EQ(info.contents.size(), expect["contents"].size());
    for (size_t i = 0; i < info.contents.size(); i++) {
        CHECK_EQ(info.contents[i].ncaId, expect["contents"][i]["ncaId"].asString());
        CHECK_EQ(info.contents[i].size, expect["contents"][i]["size"].asUint());
        CHECK_EQ(int(info.contents[i].type), int(expect["contents"][i]["type"].asInt()));
    }
    CHECK_EQ(info.installSize, info.contents[0].size + info.contents[1].size);
}

TEST(cnmt_truncated) {
    bool threw = false;
    try {
        const uint8_t tiny[8]{};
        parseCnmt(tiny, sizeof(tiny));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TRUNCATED"));
    }
    CHECK(threw);
}

TEST(cnmt_from_pfs0_meta_entry) {
    const auto nsp = slurpBytes(fixturePath("pfs0.bin"));
    const Partition p = parsePfs0(MemoryReader(nsp));
    CHECK(p.entries[0].kind == EntryKind::Cnmt);
    auto cnmtBytes = MemoryReader(nsp).readExact(p.entries[0].offset, size_t(p.entries[0].size));
    const CnmtInfo info = parseCnmt(cnmtBytes);
    CHECK_EQ(info.titleId, std::string("0100ABCDEF012000"));
    CHECK_EQ(p.entries[1].name, info.contents[0].ncaId + ".nca");
    CHECK_EQ(p.entries[2].name, info.contents[1].ncaId + ".nca");
}
