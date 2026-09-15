#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace nslib {

std::vector<uint8_t> base64Decode(const std::string& text);
std::string base64Encode(const uint8_t* data, size_t n);

/** DER bytes of the certificate's SubjectPublicKeyInfo, or nullopt if the DER is malformed. */
std::optional<std::vector<uint8_t>> spkiFromCertDer(const std::vector<uint8_t>& der);

/**
 * libcurl CURLOPT_PINNEDPUBLICKEY value (`sha256//<base64>`) for a certificate.
 * Accepts PEM (with or without the BEGIN/END lines) as returned by CURLINFO_CERTINFO.
 */
std::optional<std::string> pinForCertificate(const std::string& pem);

} // namespace nslib
