#include "formats/cnmt.hpp"
#include "formats/meta.hpp"
#include "formats/pfs0.hpp"
#include "install/record_merge.hpp"
#include "installed/compare.hpp"
#include "test.hpp"

#include <cstring>

using namespace nslib;

namespace {

std::vector<uint8_t> storedBlob(uint16_t extendedHeaderSize, const std::vector<uint8_t>& extended,
    const std::vector<ContentInfo>& infos)
{
    ContentMetaHeader header{};
    header.extendedHeaderSize = extendedHeaderSize;
    header.contentCount = uint16_t(infos.size());
    std::vector<uint8_t> blob(sizeof(header));
    std::memcpy(blob.data(), &header, sizeof(header));
    blob.insert(blob.end(), extended.begin(), extended.end());
    for (const auto& info : infos) {
        const auto* p = reinterpret_cast<const uint8_t*>(&info);
        blob.insert(blob.end(), p, p + sizeof(info));
    }
    return blob;
}

ContentInfo info(uint8_t firstByte, uint64_t size, uint8_t type) {
    ContentInfo out{};
    out.contentId[0] = firstByte;
    contentInfoSetSize(out, size);
    out.contentType = type;
    return out;
}

std::vector<uint8_t> extendedHeader(uint64_t applicationId, size_t size) {
    std::vector<uint8_t> out(size);
    std::memcpy(out.data(), &applicationId, sizeof(applicationId));
    return out;
}

} // namespace

TEST(stored_content_infos_lists_every_nca_with_its_size) {
    const uint64_t five = 5ull << 32 | 7;
    const auto blob = storedBlob(0x10, extendedHeader(0x0100000000010000ull, 0x10),
        {info(0xaa, five, 1), info(0xbb, 0x4000, 0)});
    const auto infos = storedContentInfos(blob);
    CHECK_EQ(infos.size(), 2u);
    CHECK_EQ(int(infos[0].contentId[0]), 0xaa);
    CHECK_EQ(contentInfoSize(infos[0]), five);
    CHECK_EQ(contentInfoSize(infos[1]), uint64_t(0x4000));
    CHECK_EQ(int(infos[1].contentType), 0);
}

TEST(stored_content_infos_rejects_a_short_blob) {
    auto blob = storedBlob(0x10, extendedHeader(1, 0x10), {info(1, 1, 1), info(2, 2, 0)});
    blob.resize(blob.size() - 1);
    CHECK(storedContentInfos(blob).empty());
    CHECK(storedContentInfos({1, 2, 3}).empty());
}

TEST(stored_content_infos_matches_what_the_installer_writes) {
    const auto nsp = slurpBytes(fixturePath("pfs0.bin"));
    const Partition p = parsePfs0(MemoryReader(nsp));
    const auto cnmtBytes = MemoryReader(nsp).readExact(p.entries[0].offset, size_t(p.entries[0].size));
    const CnmtInfo cnmt = parseCnmt(cnmtBytes);
    const uint8_t metaId[16] = {0x42};
    const auto blob = buildInstallContentMeta(cnmt, metaId, 0x1234);
    const auto infos = storedContentInfos(blob);
    CHECK_EQ(infos.size(), 3u);
    CHECK_EQ(int(infos.back().contentType), int(CnmtContentType::Meta));
    CHECK_EQ(int(infos.back().contentId[0]), 0x42);
    CHECK_EQ(contentInfoSize(infos.back()), uint64_t(0x1234));
}

TEST(stored_application_id_reads_updates_and_dlc_only) {
    const uint64_t app = 0x0100ABCD00010000ull;
    const auto patch = storedBlob(0x18, extendedHeader(app, 0x18), {});
    CHECK_EQ(storedApplicationId(kMetaTypePatch, patch).value_or(0), app);
    CHECK_EQ(storedApplicationId(kMetaTypeAddOnContent, patch).value_or(0), app);
    // A game's extended header starts with its patch id, which is not what callers want.
    CHECK(!storedApplicationId(kMetaTypeApplication, patch).has_value());
    CHECK(!storedApplicationId(kMetaTypePatch, storedBlob(4, {0, 0, 0, 0}, {})).has_value());
}

TEST(remove_meta_record_drops_only_that_title_on_that_storage) {
    const uint64_t app = 0x0100000000010000ull;
    const std::vector<MetaRecord> records = {
        {app, 0, kMetaTypeApplication, 5},
        {app + 0x800, 65536, kMetaTypePatch, 5},
        {app + 0x1001, 0, kMetaTypeAddOnContent, 5},
    };
    const auto left = removeMetaRecord(records, app + 0x800, 5);
    CHECK_EQ(left.size(), 2u);
    CHECK(left[0].id == app);
    CHECK(left[1].id == app + 0x1001);
    CHECK_EQ(launchVersionFor(left), 0u);
    CHECK_EQ(removeMetaRecord(records, app + 0x800, 3).size(), 3u);
}

TEST(move_meta_record_changes_only_the_storage) {
    const uint64_t app = 0x0100000000010000ull;
    const std::vector<MetaRecord> records = {
        {app, 0, kMetaTypeApplication, 5},
        {app + 0x1001, 0, kMetaTypeAddOnContent, 5},
    };
    const auto moved = moveMetaRecord(records, app + 0x1001, 5, 3);
    CHECK_EQ(unsigned(moved[0].storage), 5u);
    CHECK_EQ(unsigned(moved[1].storage), 3u);
    CHECK_EQ(moved[1].version, 0u);
    CHECK_EQ(unsigned(moveMetaRecord(records, app, 3, 4)[0].storage), 5u);
}

TEST(application_id_for_installed_titles) {
    InstalledTitle game{"0100abcd00010000", 0, "application", "sd"};
    InstalledTitle patch{"0100ABCD00010800", 65536, "patch", "sd"};
    InstalledTitle dlc{"0100ABCD00011003", 0, "addon", "nand"};
    CHECK_EQ(applicationIdFor(game), std::string("0100ABCD00010000"));
    CHECK_EQ(applicationIdFor(patch), std::string("0100ABCD00010000"));
    CHECK_EQ(applicationIdFor(dlc), std::string("0100ABCD00010000"));
    CHECK_EQ(baseTitleIdForAddon("0100ABCD00011FFF"), std::string("0100ABCD00010000"));
}

TEST(move_target_is_the_other_storage) {
    CHECK_EQ(moveTargetFor("sd", true), std::string("nand"));
    CHECK_EQ(moveTargetFor("nand", true), std::string("sd"));
    CHECK_EQ(moveTargetFor("nand", false), std::string(""));
    CHECK_EQ(moveTargetFor("gamecard", true), std::string(""));
}
