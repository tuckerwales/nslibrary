#pragma once

#include "install/engine.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace nslib {

enum class StorageTarget { Sd, Nand };

struct SpaceAvail {
    uint64_t free = 0;
    uint64_t total = 0;
};

inline uint32_t packFirmware(unsigned major, unsigned minor, unsigned micro) {
    return (major << 16) | (minor << 8) | micro;
}

bool firmwareTooNew(uint32_t requiredPacked, uint32_t currentPacked);
bool batteryShouldWarn(unsigned percent, bool charging);

/** Prefer SD when `target` is auto. Throws InstallError if neither side has `need` bytes. */
StorageTarget pickStorage(const std::string& target, uint64_t need, const std::optional<SpaceAvail>& sd,
    const SpaceAvail& nand);

std::string storageName(StorageTarget t);

} // namespace nslib
