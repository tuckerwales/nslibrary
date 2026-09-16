#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace nslib {

struct JournalEntry {
    uint8_t storage = 0;
    std::array<uint8_t, 16> id{};

    bool operator==(const JournalEntry& o) const { return storage == o.storage && id == o.id; }
};

/**
 * Placeholders this app has created but not yet registered or deleted. A crash or power
 * loss skips the install rollback, so the next launch deletes whatever is still listed.
 * Only our own placeholders are touched; system downloads are left alone.
 */
class PlaceholderJournal {
public:
    explicit PlaceholderJournal(std::string path);

    std::vector<JournalEntry> load() const;
    void add(const JournalEntry& e);
    void remove(const JournalEntry& e);
    void clear();

private:
    std::string path_;
    void save(const std::vector<JournalEntry>& entries) const;
};

std::string encodeJournal(const std::vector<JournalEntry>& entries);
std::vector<JournalEntry> decodeJournal(const std::string& text);

} // namespace nslib
