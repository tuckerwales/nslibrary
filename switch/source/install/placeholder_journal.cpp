#include "install/placeholder_journal.hpp"

#include "app/atomic_file.hpp"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <sstream>

namespace nslib {
namespace {

int hexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

} // namespace

std::string encodeJournal(const std::vector<JournalEntry>& entries) {
    std::string out;
    for (const auto& e : entries) {
        char line[64];
        int n = std::snprintf(line, sizeof(line), "%u ", unsigned(e.storage));
        for (uint8_t b : e.id) n += std::snprintf(line + n, sizeof(line) - size_t(n), "%02x", b);
        out.append(line, size_t(n));
        out.push_back('\n');
    }
    return out;
}

std::vector<JournalEntry> decodeJournal(const std::string& text) {
    std::vector<JournalEntry> out;
    std::istringstream in(text);
    std::string line;
    while (std::getline(in, line)) {
        const auto space = line.find(' ');
        if (space == std::string::npos || space == 0) continue;
        const std::string hex = line.substr(space + 1);
        if (hex.size() < 32) continue;
        JournalEntry e;
        bool ok = true;
        unsigned storage = 0;
        for (size_t i = 0; i < space; i++) {
            if (line[i] < '0' || line[i] > '9') ok = false;
            storage = storage * 10 + unsigned(line[i] - '0');
        }
        if (!ok || storage > 255) continue;
        e.storage = uint8_t(storage);
        for (size_t i = 0; i < 16; i++) {
            const int hi = hexVal(hex[i * 2]);
            const int lo = hexVal(hex[i * 2 + 1]);
            if (hi < 0 || lo < 0) {
                ok = false;
                break;
            }
            e.id[i] = uint8_t(hi << 4 | lo);
        }
        if (ok) out.push_back(e);
    }
    return out;
}

PlaceholderJournal::PlaceholderJournal(std::string path) : path_(std::move(path)) {}

std::vector<JournalEntry> PlaceholderJournal::load() const {
    std::ifstream in(path_, std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return decodeJournal(ss.str());
}

void PlaceholderJournal::save(const std::vector<JournalEntry>& entries) const {
    if (entries.empty()) {
        std::remove(path_.c_str());
        return;
    }
    writeFileAtomic(path_, encodeJournal(entries));
}

void PlaceholderJournal::add(const JournalEntry& e) {
    auto entries = load();
    if (std::find(entries.begin(), entries.end(), e) == entries.end()) entries.push_back(e);
    save(entries);
}

void PlaceholderJournal::remove(const JournalEntry& e) {
    auto entries = load();
    entries.erase(std::remove(entries.begin(), entries.end(), e), entries.end());
    save(entries);
}

void PlaceholderJournal::clear() { std::remove(path_.c_str()); }

} // namespace nslib
