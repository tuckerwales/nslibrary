#pragma once

#include "api/protocol.hpp"

#include <string>

namespace nslib {

void servicesInit();
void servicesExit();

std::string firmwareVersion();
std::string atmosphereVersion();
uint32_t currentFirmwarePacked();
unsigned batteryPercent();
bool batteryCharging();
bool isAppletMode();
DeviceInfo currentDeviceInfo(const std::string& uuid, const std::string& name);

} // namespace nslib
