#pragma once

#include "api/protocol.hpp"
#include "install/engine.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace nslib {

enum class StorageTarget { Sd, Nand };

using SpaceAvail = SpacePair;

inline uint32_t packFirmware(unsigned major, unsigned minor, unsigned micro) {
    return (major << 16) | (minor << 8) | micro;
}

/** CNMT / catalog `requiredSystemVersion` (major<<26 | minor<<20 | micro<<16 | …) → packFirmware form. */
inline uint32_t packSystemVersion(uint32_t systemVersion) {
    return packFirmware((systemVersion >> 26) & 0x3f, (systemVersion >> 20) & 0x3f, (systemVersion >> 16) & 0xf);
}

/** `requiredSystemVersion` is the raw CNMT value; `currentPacked` comes from packFirmware. */
bool firmwareTooNew(uint32_t requiredSystemVersion, uint32_t currentPacked);
bool batteryShouldWarn(unsigned percent, bool charging);

/** Prefer SD when `target` is auto. Throws InstallError if neither side has `need` bytes. */
StorageTarget pickStorage(const std::string& target, uint64_t need, const std::optional<SpaceAvail>& sd,
    const SpaceAvail& nand);

std::string storageName(StorageTarget t);

} // namespace nslib
