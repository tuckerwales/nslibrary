#include "app/services.hpp"

#ifdef __SWITCH__
#include "install/es.hpp"
#include <switch.h>
#endif

#include <cstdio>

namespace nslib {

#ifdef __SWITCH__

void servicesInit() {
    ncmInitialize();
    nsInitialize();
    esInitialize();
    splInitialize();
    psmInitialize();
    // User nicknames for the Saves tab.
    accountInitialize(AccountServiceType_Application);
}

void servicesExit() {
    accountExit();
    psmExit();
    splExit();
    esExit();
    nsExit();
    ncmExit();
}

std::string firmwareVersion() {
    SetSysFirmwareVersion fw{};
    if (R_FAILED(setsysGetFirmwareVersion(&fw))) return "unknown";
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%u.%u.%u", fw.major, fw.minor, fw.micro);
    return buf;
}

std::string atmosphereVersion() {
    u64 packed = 0;
    // Exosphere: SPLCONFIG_EXOSPHERE_ATMOSPHERE_VERSION = 65000
    if (R_FAILED(splGetConfig(SplConfigItem(65000), &packed)) || packed == 0) return "unknown";
    const unsigned major = unsigned((packed >> 24) & 0xff);
    const unsigned minor = unsigned((packed >> 16) & 0xff);
    const unsigned micro = unsigned((packed >> 8) & 0xff);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%u.%u.%u", major, minor, micro);
    return buf;
}

uint32_t currentFirmwarePacked() {
    SetSysFirmwareVersion fw{};
    if (R_FAILED(setsysGetFirmwareVersion(&fw))) return 0;
    return (uint32_t(fw.major) << 16) | (uint32_t(fw.minor) << 8) | uint32_t(fw.micro);
}

unsigned batteryPercent() {
    u32 pct = 100;
    psmGetBatteryChargePercentage(&pct);
    return unsigned(pct);
}

bool batteryCharging() {
    PsmChargerType type = PsmChargerType_Unconnected;
    psmGetChargerType(&type);
    return type != PsmChargerType_Unconnected;
}

bool isAppletMode() {
    const AppletType type = appletGetAppletType();
    return type != AppletType_Application && type != AppletType_SystemApplication;
}

std::optional<SpacePair> storageSpace(bool nand) {
    NcmContentStorage cs{};
    if (R_FAILED(ncmOpenContentStorage(&cs, nand ? NcmStorageId_BuiltInUser : NcmStorageId_SdCard))) return std::nullopt;
    s64 free = 0, total = 0;
    const Result a = ncmContentStorageGetFreeSpaceSize(&cs, &free);
    const Result b = ncmContentStorageGetTotalSpaceSize(&cs, &total);
    ncmContentStorageClose(&cs);
    if (R_FAILED(a) || R_FAILED(b)) return std::nullopt;
    return SpacePair{uint64_t(free), uint64_t(total)};
}

#else

void servicesInit() {}
void servicesExit() {}
std::string firmwareVersion() { return "0.0.0"; }
std::string atmosphereVersion() { return "0.0.0"; }
uint32_t currentFirmwarePacked() { return 0; }
unsigned batteryPercent() { return 100; }
bool batteryCharging() { return true; }
bool isAppletMode() { return true; }
std::optional<SpacePair> storageSpace(bool) { return std::nullopt; }

#endif

DeviceInfo currentDeviceInfo(const std::string& uuid, const std::string& name) {
    DeviceInfo d;
    d.deviceUuid = uuid;
    d.name = name;
    d.fw = firmwareVersion();
    d.amsVersion = atmosphereVersion();
    d.appVersion = NSLIB_VERSION;
    return d;
}

} // namespace nslib
