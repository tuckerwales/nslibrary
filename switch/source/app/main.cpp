#include "app/services.hpp"
#include "app/session.hpp"
#include "ui/connect.hpp"
#include "ui/main_activity.hpp"
#include "ui/pair.hpp"

#include <borealis.hpp>
#include <cstdlib>

#ifdef __SWITCH__
#include <switch.h>
#endif

using namespace brls::literals;

int main(int argc, char* argv[]) {
    (void)argc;
    (void)argv;

#ifdef __SWITCH__
    nxlinkStdio();
#endif

    brls::Logger::setLogLevel(brls::LogLevel::LOG_INFO);
    if (!brls::Application::init()) {
        brls::Logger::error("Unable to init Borealis");
        return EXIT_FAILURE;
    }

    brls::Application::createWindow("app/title"_i18n);
    brls::Application::setGlobalQuit(true);

    nslib::servicesInit();
    nslib::Session::instance().settings.load();

    brls::Application::registerXMLView("LibraryTab", nslib::LibraryTab::create);
    brls::Application::registerXMLView("UpdatesTab", nslib::UpdatesTab::create);
    brls::Application::registerXMLView("QueueTab", nslib::QueueTab::create);
    brls::Application::registerXMLView("InstalledTab", nslib::InstalledTab::create);
    brls::Application::registerXMLView("MissingTab", nslib::MissingTab::create);
    brls::Application::registerXMLView("SettingsTab", nslib::SettingsTab::create);

    auto& session = nslib::Session::instance();
    if (!session.hasUrl()) {
        brls::Application::pushActivity(new nslib::ConnectActivity());
    } else if (!session.hasToken()) {
        brls::Application::pushActivity(new nslib::PairActivity());
    } else {
        nslib::enterPairedSession();
    }

    while (brls::Application::mainLoop())
        ;

    session.stop();
    nslib::servicesExit();
    return EXIT_SUCCESS;
}

#ifdef __WINRT__
#include <borealis/core/main.hpp>
#endif
