#include "api/url.hpp"

#include <cctype>
#include <cstdio>

namespace nslib {
namespace {

std::string trim(std::string s) {
    size_t a = 0;
    while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) a++;
    size_t b = s.size();
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) b--;
    return s.substr(a, b - a);
}

bool hasScheme(const std::string& s) {
    const auto pos = s.find("://");
    if (pos == std::string::npos || pos == 0) return false;
    for (size_t i = 0; i < pos; i++) {
        const char c = s[i];
        if (!(std::isalpha(static_cast<unsigned char>(c)) || c == '+' || c == '-' || c == '.')) return false;
    }
    return true;
}

std::string schemeOf(const std::string& s) {
    const auto pos = s.find("://");
    if (pos == std::string::npos) return {};
    std::string out = s.substr(0, pos);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    }
    return out;
}

bool hostHasPort(const std::string& hostport) {
    if (!hostport.empty() && hostport.front() == '[') {
        const auto rb = hostport.find(']');
        return rb != std::string::npos && rb + 1 < hostport.size() && hostport[rb + 1] == ':';
    }
    const auto colon = hostport.rfind(':');
    if (colon == std::string::npos) return false;
    for (size_t i = colon + 1; i < hostport.size(); i++) {
        if (!std::isdigit(static_cast<unsigned char>(hostport[i]))) return false;
    }
    return colon + 1 < hostport.size();
}

} // namespace

std::string normalizeServerUrl(std::string url) {
    url = trim(std::move(url));
    if (url.empty()) return url;
    if (!hasScheme(url)) url = "http://" + url;

    std::string scheme = schemeOf(url);
    const auto se = url.find("://");
    std::string rest = url.substr(se + 3);
    while (!rest.empty() && rest.back() == '/') rest.pop_back();

    std::string hostport = rest;
    std::string path;
    const auto slash = rest.find('/');
    if (slash != std::string::npos) {
        hostport = rest.substr(0, slash);
        path = rest.substr(slash);
        while (!path.empty() && path.back() == '/') path.pop_back();
        if (path == "/") path.clear();
    }

    if (!hostHasPort(hostport) && scheme == "http") {
        hostport += ":" + std::to_string(kDefaultServerPort);
    }

    return scheme + "://" + hostport + path;
}

std::string joinUrl(const std::string& base, const std::string& pathAndQuery) {
    std::string b = base;
    while (!b.empty() && b.back() == '/') b.pop_back();
    if (pathAndQuery.empty()) return b;
    if (pathAndQuery.front() == '/') return b + pathAndQuery;
    return b + "/" + pathAndQuery;
}

std::string rangeHeader(uint64_t start, uint64_t length) {
    char buf[64];
    if (length == UINT64_MAX) {
        std::snprintf(buf, sizeof(buf), "bytes=%llu-", static_cast<unsigned long long>(start));
    } else if (length == 0) {
        std::snprintf(buf, sizeof(buf), "bytes=%llu-%llu", static_cast<unsigned long long>(start),
            static_cast<unsigned long long>(start ? start - 1 : 0));
    } else {
        const uint64_t end = start + length - 1;
        std::snprintf(buf, sizeof(buf), "bytes=%llu-%llu", static_cast<unsigned long long>(start),
            static_cast<unsigned long long>(end));
    }
    return buf;
}

std::string queryString(const std::vector<std::pair<std::string, std::string>>& params) {
    if (params.empty()) return {};
    std::string out = "?";
    for (size_t i = 0; i < params.size(); i++) {
        if (i) out.push_back('&');
        out += params[i].first;
        out.push_back('=');
        out += params[i].second;
    }
    return out;
}

} // namespace nslib
