#include "install/preflight.hpp"

namespace nslib {

bool firmwareTooNew(uint32_t requiredSystemVersion, uint32_t currentPacked) {
    return currentPacked != 0 && packSystemVersion(requiredSystemVersion) > currentPacked;
}

bool batteryShouldWarn(unsigned percent, bool charging) {
    return percent < 15 && !charging;
}

StorageTarget pickStorage(const std::string& target, uint64_t need, const std::optional<SpaceAvail>& sd,
    const SpaceAvail& nand)
{
    const bool sdOk = sd && sd->free >= need;
    const bool nandOk = nand.free >= need;
    if (target == "nand") {
        if (!nandOk) {
            throw InstallError("preflight", "Not enough space on NAND (" + std::to_string(need) + " bytes needed)");
        }
        return StorageTarget::Nand;
    }
    if (target == "sd") {
        if (!sdOk) {
            throw InstallError("preflight", "Not enough space on the SD card (" + std::to_string(need) + " bytes needed)");
        }
        return StorageTarget::Sd;
    }
    if (sdOk) return StorageTarget::Sd;
    if (nandOk) return StorageTarget::Nand;
    throw InstallError("preflight", "Not enough space on SD or NAND (" + std::to_string(need) + " bytes needed)");
}

std::string storageName(StorageTarget t) { return t == StorageTarget::Nand ? "nand" : "sd"; }

} // namespace nslib
