#include "installed/compare.hpp"
#include "test.hpp"
#include "ui/format.hpp"

#include <vector>

using namespace nslib;

TEST(format_sizes_read_like_the_console) {
    CHECK_EQ(formatSize(0), std::string("0 B"));
    CHECK_EQ(formatSize(900), std::string("900 B"));
    CHECK_EQ(formatSize(1024), std::string("1 KB"));
    CHECK_EQ(formatSize(5ull * 1024 * 1024), std::string("5 MB"));
    CHECK_EQ(formatSize(uint64_t(22.5 * 1024 * 1024 * 1024)), std::string("22.5 GB"));
    CHECK_EQ(formatSize(3ull * 1024 * 1024 * 1024 * 1024), std::string("3.0 TB"));
}

TEST(format_rate_and_eta_stay_quiet_when_unknown) {
    CHECK_EQ(formatRate(0), std::string(""));
    CHECK_EQ(formatRate(-1), std::string(""));
    CHECK_EQ(formatRate(2 * 1024 * 1024), std::string("2.0 MB/s"));
    CHECK_EQ(formatRate(4096), std::string("4 KB/s"));

    CHECK_EQ(formatEta(1024, 0), std::string(""));
    CHECK_EQ(formatEta(0, 1024), std::string(""));
    CHECK_EQ(formatEta(1024, 1024), std::string("1s"));
    CHECK_EQ(formatEta(90 * 1024, 1024), std::string("1m 30s"));
    CHECK_EQ(formatEta(3700 * 1024, 1024), std::string("1h 01m"));
    // A rate this slow would put the finish days away; better to say nothing.
    CHECK_EQ(formatEta(1024ull * 1024 * 1024 * 1024, 1), std::string(""));
}

TEST(format_percent_and_totals) {
    CHECK_EQ(formatPercent(0, 0), std::string(""));
    CHECK_EQ(formatPercent(1, 2), std::string("50%"));
    // A server that over-reports progress still cannot print 130%.
    CHECK_EQ(formatPercent(13, 10), std::string("100%"));
    CHECK_EQ(formatOfTotal(512 * 1024, 0), std::string("512 KB"));
    CHECK_EQ(formatOfTotal(1024 * 1024, 4ull * 1024 * 1024), std::string("1 MB / 4 MB"));
}

TEST(format_version_shows_the_release_number) {
    CHECK_EQ(formatVersion(0), std::string("v0"));
    CHECK_EQ(formatVersion(458752), std::string("v7"));
    CHECK_EQ(formatVersion(196608), std::string("v3"));
    // Low bits set is not a release counter, so keep the number the server sent.
    CHECK_EQ(formatVersion(458753), std::string("v458753"));
}

TEST(format_firmware_unpacks_the_cnmt_fields) {
    const uint32_t fw = (uint32_t(21) << 26) | (uint32_t(1) << 20) | (uint32_t(0) << 16);
    CHECK_EQ(formatFirmware(fw), std::string("21.1.0"));
    CHECK_EQ(formatFirmware(0), std::string("0.0.0"));
}

TEST(clean_title_name_drops_the_size_the_filename_carried) {
    CHECK_EQ(cleanTitleName("The Witcher 3 Wild Hunt (EU) (28.01 GB)"), std::string("The Witcher 3 Wild Hunt (EU)"));
    CHECK_EQ(cleanTitleName("Undertale (512 MB)"), std::string("Undertale"));
    CHECK_EQ(cleanTitleName("Game (1.2 gb) (28 GB)"), std::string("Game"));
    // Anything that is not a size stays put, and a name made only of a size is left alone.
    CHECK_EQ(cleanTitleName("Portal 2 (EU)"), std::string("Portal 2 (EU)"));
    CHECK_EQ(cleanTitleName("Mario Kart 8"), std::string("Mario Kart 8"));
    CHECK_EQ(cleanTitleName("(28.01 GB)"), std::string("(28.01 GB)"));
    CHECK_EQ(cleanTitleName(""), std::string(""));
}

TEST(server_identifiers_map_to_translation_keys) {
    CHECK_EQ(storageKey("sd"), std::string("app/storage/sd"));
    CHECK_EQ(storageKey("nand"), std::string("app/storage/nand"));
    CHECK_EQ(jobStatusKey("interrupted"), std::string("app/job/interrupted"));
    CHECK_EQ(installPhaseKey("content"), std::string("app/phase/content"));
    // Unknown values get no key, so callers show whatever the server sent.
    CHECK_EQ(storageKey("tape"), std::string(""));
    CHECK_EQ(jobStatusKey("weird"), std::string(""));
    CHECK_EQ(installPhaseKey("weird"), std::string(""));
}

TEST(installed_summaries_can_be_built_once_for_a_whole_catalog) {
    const std::vector<InstalledTitle> titles = {
        {"0100000000010000", 0, "application", "sd"},
        {"0100000000010800", 458752, "patch", "nand"},
        {"0100000000020000", 0, "application", "nand"},
    };
    const auto byApp = summarizeInstalledByApp(titles);

    const auto* game = findInstalled(byApp, "0100000000010000");
    CHECK(game != nullptr);
    CHECK(game->baseInstalled);
    CHECK_EQ(game->baseStorage, std::string("sd"));
    CHECK_EQ(game->patchVersion, 458752u);
    // Hex case from the catalog must not decide whether a title counts as installed.
    CHECK(findInstalled(byApp, "0100000000020000") != nullptr);
    CHECK(findInstalled(byApp, "0100000000030000") == nullptr);

    // Same answers as asking one title at a time.
    for (const char* id : {"0100000000010000", "0100000000020000"}) {
        const auto one = summarizeInstalled(titles, id);
        const auto* many = findInstalled(byApp, id);
        CHECK(many != nullptr);
        CHECK_EQ(one.baseInstalled, many->baseInstalled);
        CHECK_EQ(one.patchVersion, many->patchVersion);
    }
}

TEST(format_ago_rounds_like_the_web_ui) {
    const int64_t now = 1790000000;
    CHECK(agoFrom(now - 10, now).unit == Ago::Unit::Now);
    CHECK(agoFrom(now + 60, now).unit == Ago::Unit::Now);  // a clock that is behind the server
    const Ago minutes = agoFrom(now - 90, now);
    CHECK(minutes.unit == Ago::Unit::Minutes);
    CHECK_EQ(minutes.count, int64_t(2));
    const Ago hours = agoFrom(now - 3 * 3600 - 20 * 60, now);
    CHECK(hours.unit == Ago::Unit::Hours);
    CHECK_EQ(hours.count, int64_t(3));
    const Ago day = agoFrom(now - 26 * 3600, now);
    CHECK(day.unit == Ago::Unit::Days);
    CHECK_EQ(day.count, int64_t(1));
    CHECK(agoFrom(now - 29 * 86400, now).unit == Ago::Unit::Days);
    CHECK(agoFrom(now - 31 * 86400, now).unit == Ago::Unit::Older);
}
