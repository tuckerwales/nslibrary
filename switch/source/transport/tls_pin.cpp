#include "transport/tls_pin.hpp"

#include "formats/crypto.hpp"

namespace nslib {
namespace {

constexpr const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int b64Val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

struct Tlv {
    uint8_t tag = 0;
    size_t start = 0;  // first byte of the tag
    size_t body = 0;   // first byte of the value
    size_t end = 0;    // one past the value
};

bool readTlv(const std::vector<uint8_t>& d, size_t pos, size_t limit, Tlv& out) {
    if (pos + 2 > limit) return false;
    out.start = pos;
    out.tag = d[pos++];
    size_t len = d[pos++];
    if (len & 0x80) {
        const size_t bytes = len & 0x7f;
        if (bytes == 0 || bytes > 4 || pos + bytes > limit) return false;
        len = 0;
        for (size_t i = 0; i < bytes; i++) len = (len << 8) | d[pos++];
    }
    if (len > limit - pos) return false;
    out.body = pos;
    out.end = pos + len;
    return true;
}

} // namespace

std::vector<uint8_t> base64Decode(const std::string& text) {
    std::vector<uint8_t> out;
    uint32_t acc = 0;
    int bits = 0;
    for (char c : text) {
        if (c == '=') break;
        const int v = b64Val(c);
        if (v < 0) continue;
        acc = (acc << 6) | uint32_t(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(uint8_t((acc >> bits) & 0xff));
        }
    }
    return out;
}

std::string base64Encode(const uint8_t* data, size_t n) {
    std::string out;
    out.reserve((n + 2) / 3 * 4);
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = uint32_t(data[i]) << 16;
        if (i + 1 < n) v |= uint32_t(data[i + 1]) << 8;
        if (i + 2 < n) v |= data[i + 2];
        out.push_back(kB64[(v >> 18) & 63]);
        out.push_back(kB64[(v >> 12) & 63]);
        out.push_back(i + 1 < n ? kB64[(v >> 6) & 63] : '=');
        out.push_back(i + 2 < n ? kB64[v & 63] : '=');
    }
    return out;
}

std::optional<std::vector<uint8_t>> spkiFromCertDer(const std::vector<uint8_t>& der) {
    Tlv cert, tbs;
    if (!readTlv(der, 0, der.size(), cert) || cert.tag != 0x30) return std::nullopt;
    if (!readTlv(der, cert.body, cert.end, tbs) || tbs.tag != 0x30) return std::nullopt;
    size_t pos = tbs.body;
    Tlv field;
    if (!readTlv(der, pos, tbs.end, field)) return std::nullopt;
    if (field.tag == 0xa0) {  // [0] EXPLICIT version
        pos = field.end;
    }
    // serialNumber, signature, issuer, validity, subject
    for (int i = 0; i < 5; i++) {
        if (!readTlv(der, pos, tbs.end, field)) return std::nullopt;
        pos = field.end;
    }
    if (!readTlv(der, pos, tbs.end, field) || field.tag != 0x30) return std::nullopt;
    return std::vector<uint8_t>(der.begin() + long(field.start), der.begin() + long(field.end));
}

std::optional<std::string> pinForCertificate(const std::string& pem) {
    std::string body;
    size_t pos = 0;
    while (pos < pem.size()) {
        size_t nl = pem.find('\n', pos);
        if (nl == std::string::npos) nl = pem.size();
        const std::string line = pem.substr(pos, nl - pos);
        if (line.find("-----") == std::string::npos) body += line;
        pos = nl + 1;
    }
    const auto der = base64Decode(body);
    const auto spki = spkiFromCertDer(der);
    if (!spki) return std::nullopt;
    const auto digest = sha256(spki->data(), spki->size());
    return "sha256//" + base64Encode(digest.data(), digest.size());
}

} // namespace nslib
