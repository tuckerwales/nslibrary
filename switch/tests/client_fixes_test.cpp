#include "app/atomic_file.hpp"
#include "install/placeholder_journal.hpp"
#include "install/record_merge.hpp"
#include "installed/compare.hpp"
#include "test.hpp"
#include "transport/resume.hpp"
#include "transport/tls_pin.hpp"
#include "update/verify.hpp"

#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <vector>

using namespace nslib;

namespace {

std::string tempPath(const char* name) {
    return "/tmp/nslib-test-" + std::to_string(getpid()) + "-" + name;
}

void writeText(const std::string& path, const std::string& text) {
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) testFail("cannot write " + path);
    std::fwrite(text.data(), 1, text.size(), f);
    std::fclose(f);
}

bool fileExists(const std::string& path) { return access(path.c_str(), F_OK) == 0; }

InstalledTitle title(const char* id, uint32_t version, const char* type) {
    InstalledTitle t;
    t.titleId = id;
    t.version = version;
    t.type = type;
    t.storage = "sd";
    return t;
}

CatalogApp appWithUpdates(const char* id, std::vector<uint32_t> versions) {
    CatalogApp app;
    app.id = id;
    app.name = id;
    for (uint32_t v : versions) {
        CatalogContentRef ref;
        ref.version = v;
        ref.contentMetaId = int64_t(v) + 1;
        app.updates.push_back(ref);
    }
    return app;
}

} // namespace

TEST(record_merge_keeps_sibling_dlc) {
    const uint64_t app = 0x0100000000010000ull;
    std::vector<MetaRecord> records = {
        {app, 0, kMetaTypeApplication, 5},
        {app + 0x1001, 0, kMetaTypeAddOnContent, 5},
    };
    const MetaRecord secondDlc{app + 0x1002, 0, kMetaTypeAddOnContent, 5};
    const auto merged = mergeMetaRecord(records, secondDlc);
    CHECK_EQ(merged.size(), 3u);
    CHECK(merged[1].id == app + 0x1001);
    CHECK(merged[2].id == app + 0x1002);
}

TEST(record_merge_replaces_same_title) {
    const uint64_t app = 0x0100000000010000ull;
    std::vector<MetaRecord> records = {
        {app, 0, kMetaTypeApplication, 5},
        {app + 0x800, 65536, kMetaTypePatch, 5},
    };
    const auto merged = mergeMetaRecord(records, {app + 0x800, 131072, kMetaTypePatch, 3});
    CHECK_EQ(merged.size(), 2u);
    CHECK_EQ(merged[1].version, 131072u);
    CHECK_EQ(unsigned(merged[1].storage), 3u);
}

TEST(launch_version_ignores_addons) {
    const uint64_t app = 0x0100000000010000ull;
    std::vector<MetaRecord> records = {
        {app, 0, kMetaTypeApplication, 5},
        {app + 0x800, 65536, kMetaTypePatch, 5},
        {app + 0x1001, 999999, kMetaTypeAddOnContent, 5},
    };
    CHECK_EQ(launchVersionFor(records), 65536u);
}

TEST(base_title_id_for_patch) {
    CHECK_EQ(baseTitleIdForPatch("0100ABCD00010800"), std::string("0100ABCD00010000"));
    CHECK_EQ(baseTitleIdForPatch("0100abcd00010800"), std::string("0100ABCD00010000"));
}

TEST(find_updates_matches_patch_ids_and_skips_uninstalled) {
    const std::vector<CatalogApp> catalog = {
        appWithUpdates("0100000000010000", {131072, 65536}),  // base + v1 installed, v2 available
        appWithUpdates("0100000000020000", {65536}),          // base + v1 installed, up to date
        appWithUpdates("0100000000030000", {65536}),          // base not installed
        appWithUpdates("0100000000040000", {65536}),          // base installed, no patch yet
    };
    const std::vector<InstalledTitle> titles = {
        title("0100000000010000", 0, "application"),
        title("0100000000010800", 65536, "patch"),
        title("0100000000020000", 0, "application"),
        title("0100000000020800", 65536, "patch"),
        title("0100000000040000", 0, "application"),
    };
    const auto updates = findUpdates(catalog, titles);
    CHECK_EQ(updates.size(), 2u);
    CHECK_EQ(updates[0].app->id, std::string("0100000000010000"));
    CHECK_EQ(updates[0].installed, 65536u);
    CHECK_EQ(updates[0].newest, 131072u);
    CHECK_EQ(updates[1].app->id, std::string("0100000000040000"));
    CHECK_EQ(updates[1].installed, 0u);

    const auto s = summarizeInstalled(titles, "0100000000010000");
    CHECK(s.baseInstalled);
    CHECK_EQ(s.patchVersion, 65536u);
}

TEST(resume_resets_attempts_after_progress) {
    // Seven drops, each after some progress, must not exhaust five attempts.
    const std::string payload = "abcdefghijklmnop";
    std::string got;
    int attempts = 0;
    int waits = 0;
    const int status = streamResuming(0, payload.size(),
        [&](const uint8_t* p, size_t n) { got.append(reinterpret_cast<const char*>(p), n); },
        [&](uint64_t off, uint64_t, const ByteSink& sink) {
            attempts++;
            if (off + 2 < payload.size()) {
                sink(reinterpret_cast<const uint8_t*>(payload.data()) + off, 2);
                throw std::runtime_error("drop");
            }
            sink(reinterpret_cast<const uint8_t*>(payload.data()) + off, size_t(payload.size() - off));
            return 206;
        },
        5, [&](int failures) {
            waits++;
            CHECK_EQ(failures, 1);
        });
    CHECK_EQ(status, 206);
    CHECK_EQ(got, payload);
    CHECK_EQ(waits, attempts - 1);
    CHECK(attempts > 5);
}

TEST(resume_gives_up_after_consecutive_empty_failures) {
    int attempts = 0;
    bool threw = false;
    try {
        streamResuming(0, 10, [](const uint8_t*, size_t) {},
            [&](uint64_t, uint64_t, const ByteSink&) -> int {
                attempts++;
                throw std::runtime_error("down");
            },
            4, [](int) {});
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
    CHECK_EQ(attempts, 4);
}

TEST(resume_does_not_retry_sink_errors_or_fatal) {
    int attempts = 0;
    std::string message;
    try {
        streamResuming(0, 10, [](const uint8_t*, size_t) { throw std::runtime_error("disk full"); },
            [&](uint64_t, uint64_t, const ByteSink& sink) -> int {
                attempts++;
                const uint8_t b[4] = {1, 2, 3, 4};
                try {
                    sink(b, 4);
                } catch (...) {
                    // Transports turn a sink failure into their own transfer error.
                    throw std::runtime_error("write callback failed");
                }
                return 206;
            });
    } catch (const std::runtime_error& e) {
        message = e.what();
    }
    CHECK_EQ(message, std::string("disk full"));
    CHECK_EQ(attempts, 1);

    attempts = 0;
    message.clear();
    try {
        streamResuming(0, 10, [](const uint8_t*, size_t) {},
            [&](uint64_t, uint64_t, const ByteSink&) -> int {
                attempts++;
                throw StreamFatal("cancelled");
            });
    } catch (const StreamFatal& e) {
        message = e.what();
    }
    CHECK_EQ(message, std::string("cancelled"));
    CHECK_EQ(attempts, 1);
}

TEST(resume_returns_error_status_without_retry) {
    int attempts = 0;
    size_t delivered = 0;
    const int status = streamResuming(0, 10, [&](const uint8_t*, size_t n) { delivered += n; },
        [&](uint64_t, uint64_t, const ByteSink&) {
            attempts++;
            return 404;
        });
    CHECK_EQ(status, 404);
    CHECK_EQ(attempts, 1);
    CHECK_EQ(delivered, 0u);
}

TEST(range_response_rules) {
    CHECK(rangeResponseOk(206, 100, 10));
    CHECK(rangeResponseOk(200, 0, UINT64_MAX));
    CHECK(!rangeResponseOk(200, 100, 10));
    CHECK(!rangeResponseOk(200, 0, 10));
    CHECK(!rangeResponseOk(200, 5, UINT64_MAX));
    CHECK(!rangeResponseOk(404, 0, UINT64_MAX));
    CHECK_EQ(retryDelayMs(1), 500L);
    CHECK_EQ(retryDelayMs(2), 1000L);
    CHECK_EQ(retryDelayMs(10), 8000L);
}

TEST(atomic_file_replaces_and_recovers) {
    const std::string dest = tempPath("atomic.bin");
    std::remove(dest.c_str());
    std::remove((dest + ".old").c_str());

    writeFileAtomic(dest, std::string("one"));
    CHECK_EQ(slurpFile(dest), std::string("one"));
    writeFileAtomic(dest, std::string("two"));
    CHECK_EQ(slurpFile(dest), std::string("two"));
    CHECK(!fileExists(dest + ".old"));
    CHECK(!fileExists(dest + ".part"));

    // Simulate a crash between parking the old file and moving the new one in.
    std::rename(dest.c_str(), (dest + ".old").c_str());
    CHECK(!fileExists(dest));
    recoverReplacedFile(dest);
    CHECK_EQ(slurpFile(dest), std::string("two"));

    // A failed swap keeps the old file.
    bool threw = false;
    try {
        replaceFile(dest + ".missing-part", dest);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
    CHECK_EQ(slurpFile(dest), std::string("two"));
    std::remove(dest.c_str());
}

TEST(placeholder_journal_round_trip) {
    const std::string path = tempPath("placeholders.txt");
    std::remove(path.c_str());
    PlaceholderJournal journal(path);
    CHECK(journal.load().empty());

    JournalEntry a;
    a.storage = 5;
    for (size_t i = 0; i < 16; i++) a.id[i] = uint8_t(i * 17);
    JournalEntry b = a;
    b.storage = 3;
    b.id[0] = 0xff;

    journal.add(a);
    journal.add(b);
    journal.add(a);
    auto entries = journal.load();
    CHECK_EQ(entries.size(), 2u);
    CHECK(entries[0] == a);
    CHECK(entries[1] == b);

    journal.remove(a);
    entries = journal.load();
    CHECK_EQ(entries.size(), 1u);
    CHECK(entries[0] == b);
    journal.remove(b);
    CHECK(!fileExists(path));

    CHECK(decodeJournal("garbage\n5 zz\n").empty());
}

TEST(tls_pin_from_certificate) {
    const std::string pem = slurpFile(fixturePath("tls/cert.pem"));
    std::string expected = slurpFile(fixturePath("tls/pin.txt"));
    while (!expected.empty() && (expected.back() == '\n' || expected.back() == '\r')) expected.pop_back();
    const auto pin = pinForCertificate(pem);
    CHECK(pin.has_value());
    CHECK_EQ(*pin, "sha256//" + expected);
    CHECK(!pinForCertificate("not a certificate").has_value());

    const uint8_t bytes[] = {'h', 'i', '!', '?'};
    const std::string enc = base64Encode(bytes, sizeof(bytes));
    CHECK_EQ(enc, std::string("aGkhPw=="));
    const auto dec = base64Decode(enc);
    CHECK_EQ(dec.size(), 4u);
    CHECK(std::memcmp(dec.data(), bytes, 4) == 0);
}

TEST(signed_manifest_verification) {
    const std::string dir = std::string(FIXTURE_DIR) + "/update/";
    const auto json = slurpBytes(dir + "update.json");
    const auto sig = slurpBytes(dir + "update.json.sig");
    const auto pkBytes = slurpBytes(dir + "test.pk");
    uint8_t pk[32];
    std::memcpy(pk, pkBytes.data(), 32);

    const auto manifest = verifySignedManifest(json.data(), json.size(), sig.data(), sig.size(), pk);
    CHECK_EQ(manifest.version, std::string("9.9.9"));

    auto tampered = json;
    tampered[tampered.size() / 2] ^= 1;
    bool threw = false;
    try {
        verifySignedManifest(tampered.data(), tampered.size(), sig.data(), sig.size(), pk);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        verifySignedManifest(json.data(), json.size(), sig.data(), sig.size(), updatePublicKey());
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
}
