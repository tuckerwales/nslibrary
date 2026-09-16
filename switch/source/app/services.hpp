#pragma once

#include "api/protocol.hpp"

#include <optional>
#include <string>

namespace nslib {

void servicesInit();
void servicesExit();

std::string firmwareVersion();
std::string atmosphereVersion();
uint32_t currentFirmwarePacked();
unsigned batteryPercent();
bool batteryCharging();
/** True unless running as an application (title override). SystemApplication counts as an application. */
bool isAppletMode();
/** Free/total bytes of the SD card (`nand` false) or the NAND user partition. */
std::optional<SpacePair> storageSpace(bool nand);
DeviceInfo currentDeviceInfo(const std::string& uuid, const std::string& name);

} // namespace nslib
