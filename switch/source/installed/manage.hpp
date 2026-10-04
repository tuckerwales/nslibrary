#pragma once

#include "api/protocol.hpp"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace nslib {

/** What uninstalling or moving one row of the Installed tab would touch. */
struct TitleFootprint {
    /** Titles involved: for a game, the game with its updates and DLC; otherwise just the row. */
    size_t titles = 0;
    /** Bytes their content takes up. */
    uint64_t bytes = 0;
    /** Bytes a move to the target would copy (content already there is not copied again). */
    uint64_t toCopy = 0;
};

using MoveProgress = std::function<void(uint64_t done, uint64_t total)>;

#ifdef __SWITCH__

/** True while NSLibrary runs in place of `applicationId` (title override), so its content is in use. */
bool runningInPlaceOf(const InstalledTitle& row);

/** Size up `row` without changing anything. `moveTo` is "sd" or "nand", or empty when not moving. */
TitleFootprint measureTitle(const InstalledTitle& row, const std::string& moveTo = "");

/**
 * A game row removes the game with its updates and DLC, as HOME's "Delete Software" does; save data
 * is kept. An update or DLC row removes only that title. Throws InstallError.
 */
void uninstallTitle(const InstalledTitle& row);

/**
 * Copy `row` to `to` ("sd" or "nand"), switch HOME over to the copy, then delete the original. A game
 * row moves everything of the game that is not on `to` already. A failure or cancel removes the
 * partial copy and leaves the original alone; titles that finished moving before it stay moved.
 * Throws InstallError (result "cancelled" when `cancel` was set).
 */
void moveTitle(const InstalledTitle& row, const std::string& to, const MoveProgress& progress,
    std::atomic<bool>* cancel);

#endif

} // namespace nslib
