#include "app/file_log.hpp"
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

    brls::Logger::setLogLevel(brls::LogLevel::LOG_INFO);
    nslib::fileLogInit();
    brls::Logger::info("nslibrary {} starting", NSLIB_VERSION);
#ifdef __SWITCH__
    {
        const char* mode = "applet";
        switch (appletGetAppletType()) {
            case AppletType_Application:
            case AppletType_SystemApplication:
                mode = "application";
                break;
            default:
                break;
        }
        brls::Logger::info("log={} mode={}", nslib::fileLogPath(), mode);
    }
#endif

    if (!brls::Application::init()) {
        brls::Logger::error("Unable to init Borealis");
        nslib::fileLogExit();
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
    brls::Logger::info("boot url={} token={}", session.hasUrl(), session.hasToken());
    if (!session.hasUrl()) {
        brls::Logger::info("screen=connect");
        brls::Application::pushActivity(new nslib::ConnectActivity());
    } else if (!session.hasToken()) {
        brls::Logger::info("screen=pair");
        brls::Application::pushActivity(new nslib::PairActivity());
    } else {
        brls::Logger::info("screen=session");
        nslib::enterPairedSession();
    }

    while (brls::Application::mainLoop())
        ;

    session.stop();
    nslib::servicesExit();
    nslib::fileLogExit();
    return EXIT_SUCCESS;
}

#ifdef __WINRT__
#include <borealis/core/main.hpp>
#endif
