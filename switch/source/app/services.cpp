#include "app/services.hpp"

#ifdef __SWITCH__
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
}

void servicesExit() {
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

#else

void servicesInit() {}
void servicesExit() {}
std::string firmwareVersion() { return "0.0.0"; }
std::string atmosphereVersion() { return "0.0.0"; }

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
