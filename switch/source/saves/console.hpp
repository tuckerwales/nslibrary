#pragma once

#include "api/client.hpp"
#include "api/protocol.hpp"
#include "saves/archive.hpp"

#include <atomic>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace nslib {

/** A save on this console: a game's account save for one user, or its device save. */
struct ConsoleSave {
    uint64_t applicationId = 0;
    /** 16 uppercase hex digits. */
    std::string appId;
    /** "account" or "device". */
    std::string type;
    uint64_t uid0 = 0;
    uint64_t uid1 = 0;
    /** 32 uppercase hex digits for account saves, empty for device saves. */
    std::string userId;
    std::string userName;
    /** From the game's control data; empty when the game is no longer installed. */
    std::string gameName;
    /** From the game's control data, so a restore commits before the journal fills. 0 when unknown. */
    uint64_t journalBytes = 0;
    uint8_t rank = 0;
    uint16_t index = 0;
};

/** Whether `backup` was made from the same save as `save` on this console (same game, type and user). */
bool isSameSave(const ConsoleSave& save, const SaveBackup& backup);

/**
 * Every account and device save on this console, sorted by game name, then user. Reading each
 * game's name takes a moment, so `progress` hears how many of the saves have been looked at.
 */
std::vector<ConsoleSave> listConsoleSaves(const std::function<void(size_t done, size_t total)>& progress = {});

/** Where archives are staged on the SD card on their way to or from the server. */
constexpr const char* kSaveStagingDir = "sdmc:/config/nslibrary/tmp";

/** Removes archives an interrupted backup or restore left in the staging folder. */
void clearSaveStaging();

struct SaveBackupResult {
    /** The server's record, or the matching backup it already had. */
    std::optional<SaveBackup> backup;
    /** The server already had these exact bytes, or `unchangedSince` matched, so nothing new was kept. */
    bool unchanged = false;
    uint64_t bytes = 0;
};

/**
 * Packs the save into an archive on the SD card, then uploads it. When `unchangedSince` is the
 * archive's SHA-256 the upload is skipped. `progress` gets a phase and bytes done of a total.
 */
using SaveStepFn = std::function<void(const std::string& phase, uint64_t done, uint64_t total)>;
SaveBackupResult backupConsoleSave(const ConsoleSave& save, const std::string& origin, DeviceApiClient& client,
    const std::string& unchangedSince = {}, const SaveStepFn& progress = {});

/**
 * Downloads `backup`, checks its SHA-256 and that it fits the save, backs up the current save
 * (origin "pre-restore") so the restore can be undone, then replaces the save with it.
 */
void restoreConsoleSave(const ConsoleSave& save, const SaveBackup& backup, DeviceApiClient& client,
    const SaveStepFn& progress = {});

} // namespace nslib
