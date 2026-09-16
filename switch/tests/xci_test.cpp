#include "formats/xci.hpp"
#include "test.hpp"

using namespace nslib;

TEST(xci_secure_partition) {
    const auto bytes = slurpBytes(fixturePath("xci.bin"));
    const XciInfo info = parseXci(MemoryReader(bytes));
    CHECK_EQ(info.cardOffset, 0u);
    CHECK(info.partitions.count("secure") == 1);
    CHECK(info.partitions.count("update") == 1);
    CHECK_EQ(info.secure.entries.size(), 6u);
    bool sawUpdateNca = false;
    for (const auto& e : info.secure.entries) {
        if (e.name == "system-update.nca") sawUpdateNca = true;
    }
    CHECK(!sawUpdateNca);
}

TEST(xci_key_area) {
    const auto bytes = slurpBytes(fixturePath("xci-keyarea.bin"));
    const XciInfo info = parseXci(MemoryReader(bytes));
    CHECK_EQ(info.cardOffset, 0x1000u);
    CHECK_EQ(info.secure.entries.size(), 6u);
}

TEST(xci_rejects_nsp) {
    const auto bytes = slurpBytes(fixturePath("pfs0.bin"));
    bool threw = false;
    try {
        parseXci(MemoryReader(bytes));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_MAGIC"));
    }
    CHECK(threw);
}

TEST(xci_truncated) {
    auto bytes = slurpBytes(fixturePath("xci.bin"));
    bytes.pop_back();
    bool threw = false;
    try {
        parseXci(MemoryReader(bytes));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TRUNCATED"));
    }
    CHECK(threw);
}
