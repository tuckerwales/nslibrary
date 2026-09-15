#include "app/file_log.hpp"

#include <borealis.hpp>
#include <cstdio>
#include <ctime>
#include <mutex>
#include <string>
#include <sys/stat.h>

namespace nslib {
namespace {

std::FILE* g_file = nullptr;
std::mutex g_mu;
long long g_written = 0;
/**
 * Installs log a line every couple of seconds for hours. Without a cap the log grows until the SD
 * card is full, which breaks the installs it is there to debug. Rotate instead and keep the tail.
 */
constexpr long long kMaxLogBytes = 4LL * 1024 * 1024;

void openLog() {
    g_file = std::fopen(fileLogPath(), "w");
    g_written = 0;
}

const char* levelTag(brls::LogLevel level) {
    switch (level) {
        case brls::LogLevel::LOG_ERROR:
            return "ERR";
        case brls::LogLevel::LOG_WARNING:
            return "WRN";
        case brls::LogLevel::LOG_INFO:
            return "INF";
        case brls::LogLevel::LOG_DEBUG:
            return "DBG";
        default:
            return "VRB";
    }
}

/** Log lines arrive from the install worker threads too, so every write is serialised. */
void writeLine(const char* tag, const std::string& msg) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_file) return;
    if (g_written >= kMaxLogBytes) {
        std::fprintf(g_file, "--- log rotated at %lld bytes ---\n", g_written);
        std::fclose(g_file);
        std::remove(previousFileLogPath());
        std::rename(fileLogPath(), previousFileLogPath());
        openLog();
        if (!g_file) return;
    }
    std::time_t tt = std::time(nullptr);
    std::tm tm{};
    if (const std::tm* p = std::localtime(&tt)) tm = *p;
    const int n = std::fprintf(g_file, "%02d:%02d:%02d %s %s\n", tm.tm_hour, tm.tm_min, tm.tm_sec, tag, msg.c_str());
    if (n > 0) g_written += n;
    std::fflush(g_file);
}

} // namespace

const char* fileLogPath() {
#ifdef __SWITCH__
    return "sdmc:/config/nslibrary/nslibrary.log";
#else
    return "nslibrary.log";
#endif
}

const char* previousFileLogPath() {
#ifdef __SWITCH__
    return "sdmc:/config/nslibrary/nslibrary.prev.log";
#else
    return "nslibrary.prev.log";
#endif
}

void fileLogInit() {
#ifdef __SWITCH__
    mkdir("sdmc:/config", 0777);
    mkdir("sdmc:/config/nslibrary", 0777);
#endif
    // Keep the last run: after a hang or crash the console is usually relaunched before the log is pulled.
    std::remove(previousFileLogPath());
    std::rename(fileLogPath(), previousFileLogPath());
    openLog();
    if (!g_file) return;

    brls::Logger::getLogEvent()->subscribe([](brls::Logger::TimePoint, brls::LogLevel level, std::string msg) {
        writeLine(levelTag(level), msg);
    });
}

void fileLogExit() {
    writeLine("INF", "exit");
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_file) return;
    std::fclose(g_file);
    g_file = nullptr;
}

} // namespace nslib
