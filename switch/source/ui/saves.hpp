#pragma once

#include "api/protocol.hpp"
#include "saves/console.hpp"

#include <borealis.hpp>
#include <cstdint>
#include <string>
#include <vector>

namespace nslib {

class SavesTab : public brls::Box {
public:
    SavesTab();
    static brls::View* create();
    /** Redraws from what was last loaded; Y (or a finished backup) loads again. */
    void rebuild();
};

/** One save on this console: back it up, or restore any backup of the same game into it. */
class SaveDetailActivity : public brls::Activity {
public:
    explicit SaveDetailActivity(ConsoleSave save);
    brls::View* createContentView() override;

private:
    ConsoleSave save_;
    std::vector<SaveBackup> backups_;
    std::string error_;
    brls::Box* list_ = nullptr;

    void load();
    void fill();
    void backUp();
    void confirmRestore(const SaveBackup& backup);
    void restore(const SaveBackup& backup);
};

/** Backs up every save on the console, skipping ones identical to their newest backup. */
void backUpEverySave();

/** "2026-09-25 18:04" in the console's time zone. */
std::string formatBackupDate(int64_t epochSeconds);

} // namespace nslib
