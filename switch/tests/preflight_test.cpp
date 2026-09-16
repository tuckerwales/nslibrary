#include "install/preflight.hpp"
#include "test.hpp"

using namespace nslib;

TEST(preflight_pack_firmware) {
    CHECK_EQ(packFirmware(12, 0, 0), 0x0c0000u);
    // CNMT stores major<<26 | minor<<20 | micro<<16.
    const uint32_t fw20 = uint32_t(20) << 26;
    const uint32_t fw19 = uint32_t(19) << 26;
    const uint32_t fw12_1_2 = (uint32_t(12) << 26) | (uint32_t(1) << 20) | (uint32_t(2) << 16);
    CHECK_EQ(packSystemVersion(fw12_1_2), packFirmware(12, 1, 2));
    CHECK(firmwareTooNew(fw20, packFirmware(19, 0, 1)));
    CHECK(!firmwareTooNew(fw19, packFirmware(19, 0, 1)));
    CHECK(!firmwareTooNew(fw12_1_2, packFirmware(12, 1, 2)));
    CHECK(firmwareTooNew(fw12_1_2, packFirmware(12, 1, 1)));
    // Unknown current firmware never warns.
    CHECK(!firmwareTooNew(fw20, 0));
}

TEST(preflight_battery) {
    CHECK(batteryShouldWarn(10, false));
    CHECK(!batteryShouldWarn(10, true));
    CHECK(!batteryShouldWarn(50, false));
}

TEST(preflight_pick_storage) {
    SpaceAvail sd{100, 200};
    SpaceAvail nand{180, 300};
    CHECK(pickStorage("auto", 80, sd, nand) == StorageTarget::Sd);
    CHECK(pickStorage("auto", 150, sd, nand) == StorageTarget::Nand);
    CHECK(pickStorage("nand", 40, sd, nand) == StorageTarget::Nand);
    CHECK(pickStorage("sd", 90, sd, nand) == StorageTarget::Sd);
    bool threw = false;
    try {
        pickStorage("auto", 1000, sd, nand);
    } catch (const InstallError& e) {
        threw = true;
        CHECK_EQ(e.result, std::string("preflight"));
    }
    CHECK(threw);
    threw = false;
    try {
        pickStorage("sd", 150, sd, nand);
    } catch (const InstallError&) {
        threw = true;
    }
    CHECK(threw);
}
