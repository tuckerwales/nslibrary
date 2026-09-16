#pragma once

#include <borealis.hpp>

namespace nslib {

class MainActivity : public brls::Activity {
public:
    CONTENT_FROM_XML_RES("xml/activity/main.xml");
};

class LibraryTab : public brls::Box {
public:
    LibraryTab();
    static brls::View* create();
};

class UpdatesTab : public brls::Box {
public:
    UpdatesTab();
    static brls::View* create();
};

class QueueTab : public brls::Box {
public:
    QueueTab();
    static brls::View* create();
};

class InstalledTab : public brls::Box {
public:
    InstalledTab();
    static brls::View* create();
};

class SettingsTab : public brls::Box {
public:
    SettingsTab();
    static brls::View* create();
};

void showError(const std::string& message);
void enterPairedSession();

} // namespace nslib
