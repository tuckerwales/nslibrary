#include "ui/icon_cache.hpp"

#include "app/session.hpp"

#include <borealis.hpp>
#include <fstream>
#include <iterator>
#include <sys/stat.h>
#include <thread>

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

} // namespace

void loadAppIcon(brls::Image* image, std::shared_ptr<std::atomic<bool>> alive, const std::string& appId,
    std::optional<int64_t> rev)
{
    if (!image || !alive) return;
    const std::string path = iconPath(appId, rev);
    auto cached = readFile(path);
    if (!cached.empty()) {
        image->setImageFromMem(cached.data(), int(cached.size()));
        return;
    }

    std::thread([image, appId, rev, path, alive] {
        try {
            auto bytes = Session::instance().fetchIcon(appId, rev);
            if (bytes.empty() || !alive->load()) return;
            writeFile(path, bytes);
            brls::sync([image, bytes, alive] {
                if (!alive->load()) return;
                image->setImageFromMem(bytes.data(), int(bytes.size()));
            });
        } catch (...) {
        }
    }).detach();
}

} // namespace nslib
