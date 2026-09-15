#include "app/atomic_file.hpp"

#include <cstdio>
#include <stdexcept>
#include <sys/stat.h>

namespace nslib {
namespace {

bool exists(const std::string& path) {
    struct stat st {};
    return stat(path.c_str(), &st) == 0;
}

} // namespace

void replaceFile(const std::string& part, const std::string& dest) {
    const std::string old = dest + ".old";
    std::remove(old.c_str());
    const bool hadDest = exists(dest);
    if (hadDest && std::rename(dest.c_str(), old.c_str()) != 0) {
        std::remove(part.c_str());
        throw std::runtime_error("Could not move the old " + dest + " aside");
    }
    if (std::rename(part.c_str(), dest.c_str()) != 0) {
        if (hadDest) std::rename(old.c_str(), dest.c_str());
        std::remove(part.c_str());
        throw std::runtime_error("Could not replace " + dest);
    }
    if (hadDest) std::remove(old.c_str());
}

void writeFileAtomic(const std::string& dest, const uint8_t* data, size_t n) {
    const std::string part = dest + ".part";
    std::FILE* f = std::fopen(part.c_str(), "wb");
    if (!f) throw std::runtime_error("Could not write " + part);
    const size_t wrote = n ? std::fwrite(data, 1, n, f) : 0;
    const bool flushed = std::fflush(f) == 0;
    const bool closed = std::fclose(f) == 0;
    if (wrote != n || !flushed || !closed) {
        std::remove(part.c_str());
        throw std::runtime_error("Could not write " + part);
    }
    replaceFile(part, dest);
}

void recoverReplacedFile(const std::string& dest) {
    const std::string old = dest + ".old";
    if (!exists(dest) && exists(old)) std::rename(old.c_str(), dest.c_str());
}

} // namespace nslib
