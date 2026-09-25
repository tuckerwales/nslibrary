#pragma once

#include <cstdint>
#include <string>

namespace nslib {

/** Byte counts the way the console shows them: "22.5 GB", "940 MB", "0 B". */
std::string formatSize(uint64_t bytes);

/** Transfer rate, e.g. "12.4 MB/s". Empty while the rate is still unknown. */
std::string formatRate(double bytesPerSecond);

/** Remaining time, e.g. "45s", "3m 12s", "1h 04m". Empty when it cannot be worked out. */
std::string formatEta(double bytesLeft, double bytesPerSecond);

/** "48%", or empty when the total is unknown. */
std::string formatPercent(uint64_t done, uint64_t total);

/** "4.2 GB of 22.5 GB". */
std::string formatOfTotal(uint64_t done, uint64_t total);

/**
 * Title versions as a person reads them. Updates ship as release << 16, so 458752 is "v7".
 * Anything with low bits set keeps its raw number rather than inventing a release.
 */
std::string formatVersion(uint32_t version);

/** CNMT packed system version to "21.1.0". */
std::string formatFirmware(uint32_t systemVersion);

/**
 * Library names often carry the container size the server read off the filename, e.g.
 * "Zelda (EU) (28.01 GB)". The UI shows sizes in their own column, so drop that suffix.
 */
std::string cleanTitleName(const std::string& name);

/** How long ago something happened, rounded the way the web UI rounds it. */
struct Ago {
    enum class Unit { Now, Minutes, Hours, Days, Older } unit = Unit::Now;
    int64_t count = 0;
};
Ago agoFrom(int64_t thenSeconds, int64_t nowSeconds);

/**
 * i18n keys for the identifiers the server speaks. Each returns an empty string for a value this
 * client does not know, so callers can fall back to whatever the server sent.
 */
std::string storageKey(const std::string& storage);
std::string jobStatusKey(const std::string& status);
std::string installPhaseKey(const std::string& phase);

} // namespace nslib
