#include "install/preflight.hpp"
#include "test.hpp"

using namespace nslib;

TEST(preflight_pack_firmware) {
    CHECK_EQ(packFirmware(12, 0, 0), 0x0c0000u);
    CHECK(firmwareTooNew(packFirmware(20, 0, 0), packFirmware(19, 0, 1)));
    CHECK(!firmwareTooNew(packFirmware(19, 0, 0), packFirmware(19, 0, 1)));
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
