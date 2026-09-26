#include "api/json.hpp"
#include "api/protocol.hpp"
#include "saves/archive.hpp"
#include "test.hpp"

#include <map>
#include <optional>
#include <stdexcept>
#include <set>

using namespace nslib;

namespace {

std::string savesGolden(const char* name) { return std::string(GOLDEN_DIR) + "/saves/" + name; }

std::vector<uint8_t> fromHex(const std::string& hex) {
    std::vector<uint8_t> out;
    for (size_t i = 0; i + 1 < hex.size(); i += 2) out.push_back(uint8_t(std::stoul(hex.substr(i, 2), nullptr, 16)));
    return out;
}

/** A save held in memory: path -> contents, or nullopt for a directory. */
using Tree = std::map<std::string, std::optional<std::vector<uint8_t>>>;

class MemoryTree : public SaveTreeReader, public SaveTreeWriter {
public:
    Tree tree;
    int clears = 0;
    int commits = 0;
    /** Bytes written since the last commit, and the most ever pending at a commit. */
    uint64_t pending = 0;
    uint64_t maxPending = 0;
    /** Makes the next read of this file return one byte more than listed. */
    std::string growOnRead;

    std::vector<SaveTreeEntry> list(const std::string& dir) override {
        std::vector<SaveTreeEntry> out;
        // Deliberately unsorted, like a real directory listing.
        for (auto it = tree.rbegin(); it != tree.rend(); ++it) {
            const std::string& path = it->first;
            const std::string prefix = dir.empty() ? "" : dir + "/";
            if (path.rfind(prefix, 0) != 0 || path.size() == prefix.size()) continue;
            const std::string rest = path.substr(prefix.size());
            if (rest.find('/') != std::string::npos) continue;
            out.push_back({rest, !it->second.has_value(), it->second ? it->second->size() : 0});
        }
        return out;
    }

    void read(const std::string& path, uint64_t size, const SaveSink& sink) override {
        const auto& data = *tree.at(path);
        CHECK_EQ(uint64_t(data.size()), size);
        // Deliver in uneven pieces.
        for (size_t at = 0; at < data.size(); at += 300) sink(data.data() + at, std::min<size_t>(300, data.size() - at));
        if (path == growOnRead) {
            const uint8_t extra = 1;
            sink(&extra, 1);
        }
    }

    void clear() override {
        clears++;
        tree.clear();
    }
    void makeDir(const std::string& path) override {
        CHECK(!tree.count(path));
        tree[path] = std::nullopt;
    }
    void beginFile(const std::string& path, uint64_t size) override {
        open_ = path;
        expected_ = size;
        tree[path] = std::vector<uint8_t>();
    }
    void write(const uint8_t* data, size_t n) override {
        auto& file = *tree[open_];
        file.insert(file.end(), data, data + n);
        pending += n;
    }
    void endFile() override {
        CHECK_EQ(uint64_t(tree[open_]->size()), expected_);
        open_.clear();
    }
    void commit() override {
        commits++;
        maxPending = std::max(maxPending, pending);
        pending = 0;
    }

private:
    std::string open_;
    uint64_t expected_ = 0;
};

Tree goldenTree() {
    const Json spec = Json::parse(slurpFile(savesGolden("archive.json")));
    Tree tree;
    for (const auto& entry : spec["entries"].items()) {
        const std::string path = entry["path"].asString();
        // Parent directories are implied, as in buildSaveArchive.
        for (size_t slash = path.find('/'); slash != std::string::npos; slash = path.find('/', slash + 1)) {
            tree.emplace(path.substr(0, slash), std::nullopt);
        }
        if (entry.has("hex")) {
            tree[path] = fromHex(entry["hex"].asString());
        } else {
            tree[path] = std::nullopt;
        }
    }
    return tree;
}

std::vector<uint8_t> archiveOf(MemoryTree& tree, SaveArchiveInfo* info = nullptr) {
    std::vector<uint8_t> out;
    const auto result = writeSaveArchive(tree, [&](const uint8_t* p, size_t n) { out.insert(out.end(), p, p + n); });
    if (info) *info = result;
    return out;
}

void fixChecksum(uint8_t* h) {
    std::memset(h + 148, ' ', 8);
    uint32_t sum = 0;
    for (size_t i = 0; i < 512; i++) sum += h[i];
    char digits[8];
    std::snprintf(digits, sizeof(digits), "%06o", sum);
    std::memcpy(h + 148, digits, 6);
    h[154] = 0;
    h[155] = ' ';
}

std::string listError(const std::vector<uint8_t>& archive) {
    try {
        listSaveArchive(MemoryReader(archive));
    } catch (const FormatError& e) {
        return e.code;
    }
    return "";
}

std::vector<uint8_t> simpleArchive() {
    MemoryTree t;
    t.tree["a.bin"] = std::vector<uint8_t>{'h', 'e', 'l', 'l', 'o'};
    return archiveOf(t);
}

} // namespace

TEST(save_archive_matches_the_golden_file_byte_for_byte) {
    MemoryTree tree;
    tree.tree = goldenTree();
    SaveArchiveInfo info;
    const auto built = archiveOf(tree, &info);
    const auto golden = slurpBytes(savesGolden("archive.tar"));
    CHECK_EQ(built.size(), golden.size());
    CHECK(built == golden);
    std::string expected = slurpFile(savesGolden("archive.sha256"));
    while (!expected.empty() && (expected.back() == '\n' || expected.back() == '\r')) expected.pop_back();
    CHECK_EQ(sha256Hex(info.sha256), expected);
    CHECK_EQ(info.bytes, uint64_t(golden.size()));
    CHECK_EQ(info.files, 7u);
}

TEST(save_archive_lists_the_golden_file) {
    const auto golden = slurpBytes(savesGolden("archive.tar"));
    const auto listing = listSaveArchive(MemoryReader(golden));
    const Tree expected = goldenTree();
    CHECK_EQ(listing.entries.size(), expected.size());
    CHECK_EQ(listing.files, 7u);
    for (const auto& e : listing.entries) {
        const auto it = expected.find(e.path);
        CHECK(it != expected.end());
        CHECK_EQ(e.dir, !it->second.has_value());
        if (!e.dir) {
            const std::vector<uint8_t> data(golden.begin() + long(e.offset), golden.begin() + long(e.offset + e.size));
            CHECK(data == *it->second);
        }
    }
}

TEST(save_archive_restores_the_same_tree) {
    MemoryTree source;
    source.tree = goldenTree();
    const auto archive = archiveOf(source);
    MemoryTree target;
    target.tree["stale.bin"] = std::vector<uint8_t>{1, 2, 3};
    uint64_t lastDone = 0, lastTotal = 0;
    restoreSaveArchive(MemoryReader(archive), target, 0, [&](uint64_t done, uint64_t total) {
        CHECK(done >= lastDone);
        lastDone = done;
        lastTotal = total;
    });
    CHECK_EQ(target.clears, 1);
    CHECK(target.tree == source.tree);
    CHECK_EQ(lastDone, lastTotal);
    // Backing up the restored save gives the same bytes again.
    CHECK(archiveOf(target) == archive);
}

TEST(save_archive_restore_commits_before_the_journal_fills) {
    MemoryTree source;
    source.tree["big.bin"] = std::vector<uint8_t>(10000, 7);
    source.tree["small.bin"] = std::vector<uint8_t>(10, 1);
    const auto archive = archiveOf(source);
    MemoryTree target;
    restoreSaveArchive(MemoryReader(archive), target, 4096);
    CHECK(target.tree == source.tree);
    // Three quarters of the journal, leaving room for directory and allocation updates.
    CHECK(target.maxPending <= 3072);
    // 10010 bytes in at most 3072 at a time: at least four commits, the last one at the end.
    CHECK(target.commits >= 4);
    CHECK_EQ(target.pending, uint64_t(0));
}

TEST(save_archive_restore_of_a_save_that_fits_the_journal_is_one_commit) {
    MemoryTree source;
    source.tree["a.bin"] = std::vector<uint8_t>(1000, 1);
    source.tree["b.bin"] = std::vector<uint8_t>(1000, 2);
    source.tree["dir"] = std::nullopt;
    source.tree["dir/c.bin"] = std::vector<uint8_t>(500, 3);
    const auto archive = archiveOf(source);
    MemoryTree target;
    restoreSaveArchive(MemoryReader(archive), target, 64 * 1024);
    CHECK(target.tree == source.tree);
    // Clearing and every file go in together, so a failure part way leaves the old save.
    CHECK_EQ(target.commits, 1);
}

TEST(save_archive_restore_cancelled_at_the_start_leaves_the_save_alone) {
    MemoryTree source;
    source.tree["a.bin"] = std::vector<uint8_t>(100, 1);
    const auto archive = archiveOf(source);
    MemoryTree target;
    target.tree["old.bin"] = std::vector<uint8_t>(10, 9);
    bool threw = false;
    try {
        restoreSaveArchive(MemoryReader(archive), target, 4096, [](uint64_t done, uint64_t) {
            if (done == 0) throw std::runtime_error("cancelled");
        });
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
    CHECK_EQ(target.clears, 0);
    CHECK(target.tree.count("old.bin") == 1);
}

TEST(save_archive_restore_creates_missing_parent_directories) {
    // Another tool's archive with a nested file and no directory entries.
    const auto header = ustarHeader("x/y/z.bin", false, 3);
    std::vector<uint8_t> archive(header.begin(), header.end());
    archive.resize(512 + 512 + 1024, 0);
    archive[512] = 'a';
    archive[513] = 'b';
    archive[514] = 'c';
    MemoryTree target;
    restoreSaveArchive(MemoryReader(archive), target, 0);
    CHECK(target.tree.count("x") && !target.tree["x"]);
    CHECK(target.tree.count("x/y") && !target.tree["x/y"]);
    CHECK(*target.tree["x/y/z.bin"] == (std::vector<uint8_t>{'a', 'b', 'c'}));
}

TEST(save_archive_restore_leaves_the_save_alone_when_the_archive_is_bad) {
    auto archive = simpleArchive();
    archive[0] ^= 1;  // breaks the checksum
    MemoryTree target;
    target.tree["keep.bin"] = std::vector<uint8_t>{9};
    bool threw = false;
    try {
        restoreSaveArchive(MemoryReader(archive), target, 0);
    } catch (const FormatError&) {
        threw = true;
    }
    CHECK(threw);
    CHECK_EQ(target.clears, 0);
    CHECK(target.tree.count("keep.bin"));
}

TEST(save_archive_rejects_malformed_archives) {
    const auto good = simpleArchive();
    CHECK_EQ(listError(good), std::string());

    auto bad = good;
    bad[0] = 'b';
    CHECK_EQ(listError(bad), std::string("INVALID"));

    CHECK_EQ(listError(std::vector<uint8_t>(good.begin(), good.begin() + 512)), std::string("TRUNCATED"));
    CHECK_EQ(listError(std::vector<uint8_t>(good.begin(), good.begin() + 1536)), std::string("TRUNCATED"));
    CHECK_EQ(listError(std::vector<uint8_t>(good.begin(), good.begin() + 100)), std::string("INVALID"));
    CHECK_EQ(listError(std::vector<uint8_t>(2048, 7)), std::string("BAD_MAGIC"));

    auto trailing = good;
    trailing.resize(good.size() + 512, 1);
    CHECK_EQ(listError(trailing), std::string("INVALID"));

    auto padded = good;
    padded.resize(good.size() + 512 * 17, 0);
    CHECK_EQ(listError(padded), std::string());

    auto link = good;
    link[156] = '2';
    fixChecksum(link.data());
    CHECK_EQ(listError(link), std::string("UNSUPPORTED"));

    auto climb = good;
    std::memset(climb.data(), 0, 100);
    std::memcpy(climb.data(), "../a.bin", 8);
    fixChecksum(climb.data());
    CHECK_EQ(listError(climb), std::string("INVALID"));

    std::vector<uint8_t> dup(good.begin(), good.begin() + 1024);
    dup.insert(dup.end(), good.begin(), good.begin() + 1024);
    dup.resize(dup.size() + 1024, 0);
    CHECK_EQ(listError(dup), std::string("INVALID"));

    // A file named b, then b/c inside it.
    const auto file = ustarHeader("b", false, 0);
    const auto child = ustarHeader("b/c", false, 0);
    std::vector<uint8_t> nested(file.begin(), file.end());
    nested.insert(nested.end(), child.begin(), child.end());
    nested.resize(nested.size() + 1024, 0);
    CHECK_EQ(listError(nested), std::string("INVALID"));
}

TEST(save_archive_reads_dot_slash_archives) {
    auto root = ustarHeader("x/", true, 0);
    std::memset(root.data(), 0, 100);
    std::memcpy(root.data(), "./", 2);
    fixChecksum(root.data());
    auto dir = ustarHeader("x/", true, 0);
    std::memset(dir.data(), 0, 100);
    std::memcpy(dir.data(), "./d/", 4);
    fixChecksum(dir.data());
    auto file = ustarHeader("x", false, 1);
    std::memset(file.data(), 0, 100);
    std::memcpy(file.data(), "./d/f.bin", 9);
    fixChecksum(file.data());
    std::vector<uint8_t> archive(root.begin(), root.end());
    archive.insert(archive.end(), dir.begin(), dir.end());
    archive.insert(archive.end(), file.begin(), file.end());
    archive.push_back('z');
    archive.resize(archive.size() + 511 + 1024, 0);
    const auto listing = listSaveArchive(MemoryReader(archive));
    CHECK_EQ(listing.entries.size(), size_t(2));
    CHECK_EQ(listing.entries[0].path, std::string("d"));
    CHECK_EQ(listing.entries[1].path, std::string("d/f.bin"));
}

TEST(save_archive_notices_a_file_that_changes_while_read) {
    MemoryTree tree;
    tree.tree["grows.bin"] = std::vector<uint8_t>(10, 0);
    tree.growOnRead = "grows.bin";
    bool threw = false;
    try {
        archiveOf(tree);
    } catch (const std::runtime_error& e) {
        threw = std::string(e.what()).find("changed") != std::string::npos;
    }
    CHECK(threw);
}

TEST(save_archive_of_an_empty_save_is_two_zero_blocks) {
    MemoryTree tree;
    SaveArchiveInfo info;
    const auto archive = archiveOf(tree, &info);
    CHECK(archive == std::vector<uint8_t>(1024, 0));
    CHECK_EQ(info.files, 0u);
    MemoryTree target;
    restoreSaveArchive(MemoryReader(archive), target, 0);
    CHECK(target.tree.empty());
    CHECK(target.commits >= 1);
}

TEST(save_archive_paths_follow_the_server_rules) {
    CHECK_EQ(saveArchivePathProblem("ok/path.bin"), std::string());
    CHECK(!saveArchivePathProblem("").empty());
    CHECK(!saveArchivePathProblem("/abs").empty());
    CHECK(!saveArchivePathProblem("a/../b").empty());
    CHECK(!saveArchivePathProblem("a//b").empty());
    CHECK(!saveArchivePathProblem("a\\\\b").empty());
    CHECK(!saveArchivePathProblem(std::string(255, 'x')).empty());
    CHECK_EQ(saveArchivePathProblem(std::string(254, 'x')), std::string());

    std::string prefix, name;
    CHECK(splitUstarPath(std::string(150, 'p') + "/" + std::string(90, 'n'), prefix, name));
    CHECK_EQ(prefix, std::string(150, 'p'));
    CHECK_EQ(name, std::string(90, 'n'));
    CHECK(!splitUstarPath(std::string(160, 'p') + "/" + std::string(90, 'n'), prefix, name));
    CHECK(!splitUstarPath("p/" + std::string(120, 'n'), prefix, name));

    MemoryTree bad;
    bad.tree["a\\\\b"] = std::vector<uint8_t>{1};
    bool threw = false;
    try {
        archiveOf(bad);
    } catch (const FormatError&) {
        threw = true;
    }
    CHECK(threw);
}

TEST(save_account_ids_are_32_uppercase_hex_digits) {
    CHECK_EQ(accountIdHex(0x0123456789ABCDEFull, 0x0FEDCBA987654321ull), std::string("0123456789ABCDEF0FEDCBA987654321"));
    CHECK_EQ(accountIdHex(0, 1), std::string("00000000000000000000000000000001"));
}

TEST(protocol_save_list_golden) {
    const auto list = parseSaveList(slurpFile(goldenPath("save-list-response.json")));
    CHECK_EQ(list.size(), size_t(2));
    CHECK_EQ(list[0].id, int64_t(12));
    CHECK_EQ(list[0].app, std::string("0100ABCDEF010000"));
    CHECK_EQ(list[0].type, std::string("account"));
    CHECK_EQ(list[0].user, std::string("0123456789ABCDEF0FEDCBA987654321"));
    CHECK_EQ(list[0].userName, std::string("Player"));
    CHECK_EQ(list[0].device, std::string("Living room"));
    CHECK(list[0].mine);
    CHECK_EQ(list[0].files, 7u);
    CHECK_EQ(list[0].at, int64_t(1790000000));
    CHECK_EQ(list[1].type, std::string("device"));
    CHECK(list[1].user.empty());
    CHECK(list[1].pinned);
    CHECK_EQ(list[1].origin, std::string("pre-restore"));
    CHECK_EQ(list[1].note, std::string("Before the final boss"));
}

TEST(protocol_save_upload_golden) {
    const auto r = parseSaveUpload(slurpFile(goldenPath("save-upload-response.json")));
    CHECK(r.dup);
    CHECK_EQ(r.backup.id, int64_t(12));
}

TEST(protocol_save_upload_path_encodes_every_field) {
    SaveUploadQuery q;
    q.app = "0100ABCDEF010000";
    q.type = "account";
    q.user = "0123456789ABCDEF0FEDCBA987654321";
    q.userName = "Zoë & Co";
    q.name = "A/B?";
    q.sha256 = std::string(64, 'a');
    CHECK_EQ(saveUploadPath(q),
        std::string("/saves?app=0100ABCDEF010000&type=account&user=0123456789ABCDEF0FEDCBA987654321"
                    "&userName=Zo%C3%AB%20%26%20Co&name=A%2FB%3F&origin=manual&sha256=") +
            std::string(64, 'a'));
    SaveUploadQuery device;
    device.app = "0100ABCDEF010000";
    device.type = "device";
    device.origin = "pre-restore";
    device.sha256 = "b";
    CHECK_EQ(saveUploadPath(device), std::string("/saves?app=0100ABCDEF010000&type=device&origin=pre-restore&sha256=b"));
}
