#include "ui/icon_cache.hpp"

#include "app/session.hpp"

#include <borealis.hpp>
#include <deque>
#include <fstream>
#include <iterator>
#include <mutex>
#include <sys/stat.h>

namespace nslib {
namespace {

constexpr const char* kIconDir = "sdmc:/config/nslibrary/icons";

std::string iconPath(const std::string& appId, std::optional<int64_t> rev) {
    return std::string(kIconDir) + "/" + appId + "_" + (rev ? std::to_string(*rev) : "0") + ".jpg";
}

std::vector<uint8_t> readFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return {};
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

void writeFile(const std::string& path, const std::vector<uint8_t>& bytes) {
    mkdir("sdmc:/config", 0777);
    mkdir("sdmc:/config/nslibrary", 0777);
    mkdir(kIconDir, 0777);
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
}

struct IconJob {
    brls::Image* image = nullptr;
    std::shared_ptr<std::atomic<bool>> alive;
    std::string appId;
    std::optional<int64_t> rev;
    std::string path;
};

std::mutex g_mu;
std::deque<IconJob> g_q;
bool g_pumping = false;

void pumpIcons() {
    IconJob job;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        if (g_q.empty()) {
            g_pumping = false;
            return;
        }
        job = std::move(g_q.front());
        g_q.pop_front();
    }
    if (Session::instance().isOffline() || Session::instance().isInstalling()) {
        // Drop the queue: blocking connects to a dead server would freeze the UI once per icon.
        std::lock_guard<std::mutex> lock(g_mu);
        g_q.clear();
        g_pumping = false;
        return;
    }
    if (job.alive && job.alive->load() && job.image) {
        try {
            auto bytes = Session::instance().fetchIcon(job.appId, job.rev);
            const bool jpeg = bytes.size() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8;
            if (jpeg && job.alive->load()) {
                writeFile(job.path, bytes);
                job.image->setImageFromMem(bytes.data(), int(bytes.size()));
            }
        } catch (const std::exception& e) {
            brls::Logger::warning("icon {}: {}", job.appId, e.what());
        }
    }
    brls::delay(0, [] { pumpIcons(); });
}

} // namespace

void loadAppIcon(brls::Image* image, std::shared_ptr<std::atomic<bool>> alive, const std::string& appId,
    std::optional<int64_t> rev, bool fetchRemote)
{
    if (!image || !alive) return;
    const std::string path = iconPath(appId, rev);
    auto cached = readFile(path);
    if (!cached.empty()) {
        const bool jpeg = cached.size() >= 3 && cached[0] == 0xff && cached[1] == 0xd8;
        if (jpeg) image->setImageFromMem(cached.data(), int(cached.size()));
        return;
    }
    if (!fetchRemote) return;

    bool startPump = false;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        g_q.push_back(IconJob{image, std::move(alive), appId, rev, path});
        if (!g_pumping) {
            g_pumping = true;
            startPump = true;
        }
    }
    if (startPump) brls::delay(0, [] { pumpIcons(); });
}

} // namespace nslib
