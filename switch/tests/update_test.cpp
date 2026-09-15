#include "test.hpp"
#include "transport/resume.hpp"
#include "update/manifest.hpp"
#include "update/verify.hpp"

#include <cstring>
#include <string>
#include <vector>

using namespace nslib;

static std::string updateFixture(const char* name) {
    return std::string(FIXTURE_DIR) + "/update/" + name;
}

TEST(update_parse_github_release) {
    GithubReleaseAssets rel;
    std::string error;
    CHECK(parseGithubRelease(slurpFile(updateFixture("github-release.json")), rel, error));
    CHECK_EQ(rel.version, std::string("9.9.9"));
    CHECK_EQ(rel.nroUrl, std::string("https://example.test/nslibrary.nro"));
    CHECK_EQ(rel.jsonUrl, std::string("https://example.test/update.json"));
    CHECK_EQ(rel.sigUrl, std::string("https://example.test/update.json.sig"));
    CHECK(rel.nroSize > 0);
}

TEST(update_parse_manifest) {
    UpdateManifest m;
    std::string error;
    CHECK(parseUpdateManifest(slurpFile(updateFixture("update.json")), m, error));
    CHECK_EQ(m.version, std::string("9.9.9"));
    CHECK_EQ(m.size, 26u);
    CHECK_EQ(m.sha256.size(), 64u);
}

TEST(update_rejects_unsigned_json) {
    const auto json = slurpFile(updateFixture("update.json"));
    uint8_t pk[32];
    const auto pkBytes = slurpBytes(updateFixture("test.pk"));
    CHECK_EQ(pkBytes.size(), 32u);
    std::memcpy(pk, pkBytes.data(), 32);
    uint8_t sig[64]{};
    CHECK(!verifyUpdateDocument(reinterpret_cast<const uint8_t*>(json.data()), json.size(), sig, 64, pk));
}

TEST(update_verifies_node_signature_and_nro_hash) {
    const auto json = slurpFile(updateFixture("update.json"));
    const auto sig = slurpBytes(updateFixture("update.json.sig"));
    auto nro = slurpBytes(updateFixture("nro.bin"));
    uint8_t pk[32];
    const auto pkBytes = slurpBytes(updateFixture("test.pk"));
    CHECK_EQ(pkBytes.size(), 32u);
    CHECK_EQ(sig.size(), 64u);
    std::memcpy(pk, pkBytes.data(), 32);
    CHECK(verifyUpdateDocument(
        reinterpret_cast<const uint8_t*>(json.data()), json.size(), sig.data(), sig.size(), pk));
    UpdateManifest m;
    std::string error;
    CHECK(parseUpdateManifest(json, m, error));
    CHECK(nroMatchesManifest(nro.data(), nro.size(), m, error));
    nro[0] ^= 0xff;
    CHECK(!nroMatchesManifest(nro.data(), nro.size(), m, error));
}

TEST(update_strip_tag_and_version_order) {
    CHECK_EQ(stripVersionTag("v0.2.0"), std::string("0.2.0"));
    CHECK(cmpVersion("0.1.0", "9.9.9") < 0);
    CHECK(cmpVersion("9.9.9", "9.9.9") == 0);
}
