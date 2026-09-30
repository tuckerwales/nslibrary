#include "ui/format.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace nslib {
namespace {

constexpr double kKb = 1024.0;
constexpr double kMb = 1024.0 * 1024.0;
constexpr double kGb = 1024.0 * 1024.0 * 1024.0;
constexpr double kTb = 1024.0 * 1024.0 * 1024.0 * 1024.0;

std::string print(const char* fmt, double value, const char* unit) {
    char buf[48];
    std::snprintf(buf, sizeof(buf), fmt, value, unit);
    return buf;
}

/** True when `text` ends with `suffix`, comparing without regard to case. */
bool endsWithNoCase(const std::string& text, const std::string& suffix) {
    if (suffix.size() > text.size()) return false;
    for (size_t i = 0; i < suffix.size(); i++) {
        const char a = text[text.size() - suffix.size() + i];
        const char b = suffix[i];
        const char la = (a >= 'A' && a <= 'Z') ? char(a - 'A' + 'a') : a;
        const char lb = (b >= 'A' && b <= 'Z') ? char(b - 'A' + 'a') : b;
        if (la != lb) return false;
    }
    return true;
}

} // namespace

std::string formatSize(uint64_t bytes) {
    const double n = double(bytes);
    if (bytes >= uint64_t(kTb)) return print("%.1f %s", n / kTb, "TB");
    if (bytes >= uint64_t(kGb)) return print("%.1f %s", n / kGb, "GB");
    if (bytes >= uint64_t(kMb)) return print("%.0f %s", n / kMb, "MB");
    if (bytes >= uint64_t(kKb)) return print("%.0f %s", n / kKb, "KB");
    return print("%.0f %s", n, "B");
}

std::string formatRate(double bytesPerSecond) {
    if (!(bytesPerSecond > 0) || !std::isfinite(bytesPerSecond)) return "";
    if (bytesPerSecond >= kMb) return print("%.1f %s", bytesPerSecond / kMb, "MB/s");
    if (bytesPerSecond >= kKb) return print("%.0f %s", bytesPerSecond / kKb, "KB/s");
    return print("%.0f %s", bytesPerSecond, "B/s");
}

std::string formatEta(double bytesLeft, double bytesPerSecond) {
    if (!(bytesPerSecond > 0) || !std::isfinite(bytesPerSecond)) return "";
    if (!(bytesLeft > 0) || !std::isfinite(bytesLeft)) return "";
    const double exact = bytesLeft / bytesPerSecond;
    // Past a day the number says nothing useful; the rate line already shows how slow it is.
    if (!(exact < 24 * 60 * 60)) return "";
    const int seconds = std::max(1, int(std::ceil(exact)));
    char buf[32];
    if (seconds < 60) {
        std::snprintf(buf, sizeof(buf), "%ds", seconds);
    } else if (seconds < 60 * 60) {
        std::snprintf(buf, sizeof(buf), "%dm %02ds", seconds / 60, seconds % 60);
    } else {
        std::snprintf(buf, sizeof(buf), "%dh %02dm", seconds / 3600, (seconds % 3600) / 60);
    }
    return buf;
}

std::string formatPercent(uint64_t done, uint64_t total) {
    if (total == 0) return "";
    const double ratio = std::min(1.0, double(done) / double(total));
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%.0f%%", ratio * 100.0);
    return buf;
}

std::string formatOfTotal(uint64_t done, uint64_t total) {
    if (total == 0) return formatSize(done);
    return formatSize(done) + " / " + formatSize(total);
}

std::string formatVersion(uint32_t version) {
    if ((version & 0xffff) == 0) return "v" + std::to_string(version >> 16);
    return "v" + std::to_string(version);
}

std::string formatFirmware(uint32_t systemVersion) {
    return std::to_string((systemVersion >> 26) & 0x3f) + "." + std::to_string((systemVersion >> 20) & 0x3f) + "." +
        std::to_string((systemVersion >> 16) & 0xf);
}

std::string cleanTitleName(const std::string& name) {
    static const char* kUnits[] = {"TB", "GB", "MB", "KB", "B"};
    std::string out = name;
    // Filenames can carry more than one, e.g. "Game (EU) (1.2 GB) (28.01 GB)".
    for (int pass = 0; pass < 2; pass++) {
        while (!out.empty() && out.back() == ' ') out.pop_back();
        if (out.empty() || out.back() != ')') break;
        const size_t open = out.rfind('(');
        if (open == std::string::npos || open == 0) break;
        std::string inner = out.substr(open + 1, out.size() - open - 2);
        bool matched = false;
        for (const char* unit : kUnits) {
            if (!endsWithNoCase(inner, unit)) continue;
            std::string number = inner.substr(0, inner.size() - std::string(unit).size());
            while (!number.empty() && number.back() == ' ') number.pop_back();
            if (number.empty()) continue;
            bool numeric = true;
            int dots = 0;
            for (char c : number) {
                if (c == '.') dots++;
                else if (c < '0' || c > '9') numeric = false;
            }
            if (!numeric || dots > 1) continue;
            matched = true;
            break;
        }
        if (!matched) break;
        out = out.substr(0, open);
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out.empty() ? name : out;
}

std::string storageKey(const std::string& storage) {
    if (storage == "sd") return "app/storage/sd";
    if (storage == "nand") return "app/storage/nand";
    if (storage == "auto") return "app/storage/auto";
    return "";
}

std::string jobStatusKey(const std::string& status) {
    if (status == "queued") return "app/job/queued";
    if (status == "claimed") return "app/job/claimed";
    if (status == "running") return "app/job/running";
    if (status == "done") return "app/job/done";
    if (status == "failed") return "app/job/failed";
    if (status == "cancelled") return "app/job/cancelled";
    if (status == "interrupted") return "app/job/interrupted";
    return "";
}

std::string installPhaseKey(const std::string& phase) {
    if (phase == "preflight") return "app/phase/preflight";
    if (phase == "ticket") return "app/phase/ticket";
    if (phase == "meta") return "app/phase/meta";
    if (phase == "content") return "app/phase/content";
    if (phase == "commit") return "app/phase/commit";
    if (phase == "record") return "app/phase/record";
    return "";
}

Ago agoFrom(int64_t thenSeconds, int64_t nowSeconds) {
    const auto rounded = [](int64_t value, int64_t unit) { return (value + unit / 2) / unit; };
    const int64_t seconds = nowSeconds > thenSeconds ? nowSeconds - thenSeconds : 0;
    if (seconds < 45) return {Ago::Unit::Now, 0};
    const int64_t minutes = rounded(seconds, 60);
    if (minutes < 60) return {Ago::Unit::Minutes, minutes};
    const int64_t hours = rounded(minutes, 60);
    if (hours < 24) return {Ago::Unit::Hours, hours};
    const int64_t days = rounded(hours, 24);
    if (days < 30) return {Ago::Unit::Days, days};
    return {Ago::Unit::Older, days};
}

} // namespace nslib
