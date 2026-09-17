#pragma once

#include <borealis.hpp>

#include <cstdint>
#include <functional>
#include <string>

namespace nslib {

class MainActivity : public brls::Activity {
public:
    CONTENT_FROM_XML_RES("activity/main.xml");
};

class LibraryTab : public brls::Box {
public:
    LibraryTab();
    static brls::View* create();
    /** Rebuilds the grid only when the catalog changed, keeping focus on the same title. */
    void rebuild(bool force = false);

private:
    int64_t builtRev_ = -1;
    size_t builtCount_ = 0;
    size_t builtInstalled_ = 0;
};

class UpdatesTab : public brls::Box {
public:
    UpdatesTab();
    static brls::View* create();
    void rebuild();
};

class QueueTab : public brls::Box {
public:
    QueueTab();
    static brls::View* create();
    void rebuild();
};

class InstalledTab : public brls::Box {
public:
    InstalledTab();
    static brls::View* create();
    void rebuild();
};

class MissingTab : public brls::Box {
public:
    MissingTab();
    static brls::View* create();
    void rebuild();
};

class SettingsTab : public brls::Box {
public:
    SettingsTab();
    static brls::View* create();
};

enum class Screen { Connect, Pair, Main };

/**
 * Pop every activity above the first one, then show `screen` (pushing it unless it is already the
 * root) and run `then`. Keeps Connect/Pair/Main from piling up on the stack.
 */
void showScreen(Screen screen, std::function<void()> then = {});

/**
 * Replace the children of `list` with what `build` adds. If focus was inside the old children it
 * moves to `focusTarget()` (or the first focusable new view) before the old views are freed.
 */
void replaceChildren(brls::Box* list, const std::function<void(brls::Box*)>& build,
    const std::function<brls::View*()>& focusTarget = {});

void showError(const std::string& message);
void enterPairedSession();
/** Rebuild whichever tab is on screen after the catalog, jobs, or installed titles change. */
void refreshVisibleTabs();

} // namespace nslib
