#include "app/file_log.hpp"

#include <borealis.hpp>
#include <cstdio>
#include <ctime>
#include <string>
#include <sys/stat.h>

namespace nslib {
namespace {

std::FILE* g_file = nullptr;

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

void writeLine(const char* tag, const std::string& msg) {
    if (!g_file) return;
    std::time_t tt = std::time(nullptr);
    std::tm tm{};
    if (const std::tm* p = std::localtime(&tt)) tm = *p;
    std::fprintf(g_file, "%02d:%02d:%02d %s %s\n", tm.tm_hour, tm.tm_min, tm.tm_sec, tag, msg.c_str());
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

void fileLogInit() {
#ifdef __SWITCH__
    mkdir("sdmc:/config", 0777);
    mkdir("sdmc:/config/nslibrary", 0777);
#endif
    g_file = std::fopen(fileLogPath(), "w");
    if (!g_file) return;

    brls::Logger::getLogEvent()->subscribe([](brls::Logger::TimePoint, brls::LogLevel level, std::string msg) {
        writeLine(levelTag(level), msg);
    });
}

void fileLogExit() {
    if (!g_file) return;
    writeLine("INF", "exit");
    std::fclose(g_file);
    g_file = nullptr;
}

} // namespace nslib
