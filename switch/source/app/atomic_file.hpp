#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace nslib {

/**
 * Move `part` over `dest` so a crash never leaves neither file behind.
 * FAT cannot rename over an existing file, so the old copy is parked at `dest.old`
 * first and restored if the swap fails. Throws std::runtime_error on failure.
 */
void replaceFile(const std::string& part, const std::string& dest);

/** Write `data` to `dest.part`, then replaceFile. */
void writeFileAtomic(const std::string& dest, const uint8_t* data, size_t n);
inline void writeFileAtomic(const std::string& dest, const std::string& data) {
    writeFileAtomic(dest, reinterpret_cast<const uint8_t*>(data.data()), data.size());
}

/** If a previous run crashed mid-swap (`dest` missing, `dest.old` present), put the old file back. */
void recoverReplacedFile(const std::string& dest);

} // namespace nslib
