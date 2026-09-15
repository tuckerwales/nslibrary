#include "api/json.hpp"
#include "formats/cnmt.hpp"
#include "formats/meta.hpp"
#include "formats/pfs0.hpp"
#include "test.hpp"

#include <cstdlib>
#include <cstring>

using namespace nslib;

TEST(install_content_meta_includes_meta_nca) {
    const auto nsp = slurpBytes(fixturePath("pfs0.bin"));
    const Partition p = parsePfs0(MemoryReader(nsp));
    auto cnmtBytes = MemoryReader(nsp).readExact(p.entries[0].offset, size_t(p.entries[0].size));
    const CnmtInfo cnmt = parseCnmt(cnmtBytes);

    uint8_t metaId[16];
    // Filename stem of the cnmt NCA is the content id.
    const auto stem = p.entries[0].name.substr(0, 32);
    for (int i = 0; i < 16; i++) {
        const auto byte = stem.substr(size_t(i * 2), 2);
        metaId[i] = uint8_t(strtoul(byte.c_str(), nullptr, 16));
    }

    const auto blob = buildInstallContentMeta(cnmt, metaId, p.entries[0].size);
    CHECK(blob.size() >= sizeof(ContentMetaHeader) + cnmt.extendedHeader.size() + 3 * sizeof(ContentInfo));

    ContentMetaHeader header{};
    std::memcpy(&header, blob.data(), sizeof(header));
    CHECK_EQ(header.extendedHeaderSize, cnmt.extendedHeaderSize);
    CHECK_EQ(int(header.contentCount), 3); // program + control + meta
    CHECK_EQ(int(header.storageId), 0);

    const uint8_t* infos = blob.data() + sizeof(header) + cnmt.extendedHeader.size();
    ContentInfo last{};
    std::memcpy(&last, infos + 2 * sizeof(ContentInfo), sizeof(last));
    CHECK_EQ(int(last.contentType), int(CnmtContentType::Meta));
    CHECK(std::memcmp(last.contentId, metaId, 16) == 0);
    uint64_t size = 0;
    size = uint64_t(last.sizeLow) | (uint64_t(last.sizeHigh) << 32);
    CHECK_EQ(size, p.entries[0].size);
}

TEST(required_system_version_is_cleared_from_stored_meta) {
    const auto nsp = slurpBytes(fixturePath("pfs0.bin"));
    const Partition p = parsePfs0(MemoryReader(nsp));
    auto cnmtBytes = MemoryReader(nsp).readExact(p.entries[0].offset, size_t(p.entries[0].size));
    const CnmtInfo cnmt = parseCnmt(cnmtBytes);
    CHECK(cnmt.requiredSystemVersion != 0);

    const uint8_t metaId[16] = {};
    auto blob = buildInstallContentMeta(cnmt, metaId, p.entries[0].size);
    const auto before = blob;
    CHECK_EQ(storedRequiredSystemVersion(cnmt.rawType, blob).value_or(0), cnmt.requiredSystemVersion);

    CHECK(clearRequiredSystemVersion(cnmt.rawType, blob));
    CHECK_EQ(storedRequiredSystemVersion(cnmt.rawType, blob).value_or(1), 0u);
    CHECK_EQ(blob.size(), before.size());
    // Only those four bytes move; the patch id and content records stay as they were.
    size_t changed = 0;
    for (size_t i = 0; i < blob.size(); i++) changed += blob[i] != before[i];
    CHECK(changed > 0 && changed <= 4);
    CHECK(!clearRequiredSystemVersion(cnmt.rawType, blob));

    // DLC has no firmware field at that offset, so it is left alone.
    auto addon = before;
    CHECK(!storedRequiredSystemVersion(uint8_t(CnmtType::AddOnContent), addon));
    CHECK(!clearRequiredSystemVersion(uint8_t(CnmtType::AddOnContent), addon));
    CHECK(addon == before);
}
