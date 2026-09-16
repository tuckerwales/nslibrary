#include "transport/http.hpp"

#include "api/url.hpp"
#include "transport/resume.hpp"

#include <curl/curl.h>
#include <stdexcept>
#include <sys/socket.h>
#include <vector>

namespace nslib {
namespace {

std::string lower(std::string s) {
    for (char& c : s) {
        if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    }
    return s;
}

size_t writeBody(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* body = static_cast<std::string*>(userdata);
    body->append(ptr, size * nmemb);
    return size * nmemb;
}

size_t writeHeaders(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* headers = static_cast<std::map<std::string, std::string>*>(userdata);
    const size_t n = size * nmemb;
    std::string line(ptr, n);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    const auto colon = line.find(':');
    if (colon == std::string::npos) return n;
    std::string key = lower(line.substr(0, colon));
    std::string value = line.substr(colon + 1);
    size_t a = 0;
    while (a < value.size() && (value[a] == ' ' || value[a] == '\t')) a++;
    value.erase(0, a);
    (*headers)[key] = value;
    return n;
}

struct StreamState {
    const ByteSink* sink = nullptr;
    uint64_t written = 0;
};

size_t writeStream(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* st = static_cast<StreamState*>(userdata);
    const size_t n = size * nmemb;
    try {
        (*st->sink)(reinterpret_cast<const uint8_t*>(ptr), n);
        st->written += n;
        return n;
    } catch (...) {
        return 0;
    }
}

curl_slist* appendHeaders(curl_slist* list, const std::string& token,
    const std::vector<std::pair<std::string, std::string>>& extra, bool json)
{
    if (!token.empty()) {
        const std::string auth = "Authorization: Bearer " + token;
        list = curl_slist_append(list, auth.c_str());
    }
    if (json) list = curl_slist_append(list, "Content-Type: application/json");
    list = curl_slist_append(list, "Accept: application/json, application/octet-stream");
    for (const auto& h : extra) {
        const std::string line = h.first + ": " + h.second;
        list = curl_slist_append(list, line.c_str());
    }
    return list;
}

int sockoptLargeBuffers(void*, curl_socket_t fd, curlsocktype) {
    const int sz = 1024 * 1024;
    setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &sz, sizeof(sz));
    setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sz, sizeof(sz));
    return CURL_SOCKOPT_OK;
}

} // namespace

HttpTransport::HttpTransport(std::string baseUrl) : baseUrl_(normalizeServerUrl(std::move(baseUrl))) {
    static std::once_flag once;
    std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
    curl_ = curl_easy_init();
    if (!curl_) throw std::runtime_error("curl_easy_init failed");
}

HttpTransport::~HttpTransport() {
    if (curl_) curl_easy_cleanup(curl_);
}

HttpResponse HttpTransport::request(
    const std::string& method,
    const std::string& path,
    const std::string* jsonBody,
    const std::vector<std::pair<std::string, std::string>>& extraHeaders)
{
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string url = joinUrl(baseUrl_, std::string(kDeviceApiBasePath) + path);
    HttpResponse out;
    curl_easy_reset(curl_);
    curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl_, CURLOPT_CUSTOMREQUEST, method.c_str());
    curl_easy_setopt(curl_, CURLOPT_USERAGENT, "nslibrary/" NSLIB_VERSION);
    curl_easy_setopt(curl_, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(curl_, CURLOPT_TIMEOUT_MS, timeoutMs_);
    curl_easy_setopt(curl_, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
    curl_easy_setopt(curl_, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(curl_, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl_, CURLOPT_BUFFERSIZE, 1024L * 1024L);
    curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, writeBody);
    curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &out.body);
    curl_easy_setopt(curl_, CURLOPT_HEADERFUNCTION, writeHeaders);
    curl_easy_setopt(curl_, CURLOPT_HEADERDATA, &out.headers);
    curl_slist* hdr = appendHeaders(nullptr, token_, extraHeaders, jsonBody != nullptr);
    curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, hdr);
    if (jsonBody) {
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDS, jsonBody->c_str());
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE, long(jsonBody->size()));
    }
    const CURLcode rc = curl_easy_perform(curl_);
    curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &out.status);
    curl_slist_free_all(hdr);
    if (rc != CURLE_OK) {
        throw std::runtime_error(std::string("HTTP ") + method + " " + path + ": " + curl_easy_strerror(rc));
    }
    return out;
}

int HttpTransport::stream(
    const std::string& path,
    uint64_t offset,
    uint64_t length,
    const std::vector<std::pair<std::string, std::string>>& extraHeaders,
    const std::function<void(const uint8_t*, size_t)>& sink)
{
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string url = joinUrl(baseUrl_, std::string(kDeviceApiBasePath) + path);
    return streamResuming(offset, length, sink,
        [&](uint64_t start, uint64_t remain, const ByteSink& emit) {
            auto headers = extraHeaders;
            headers.emplace_back("Range", rangeHeader(start, remain));
            StreamState st;
            st.sink = &emit;
            st.written = 0;
            HttpResponse hdrs;
            long status = 0;
            curl_easy_reset(curl_);
            curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
            curl_easy_setopt(curl_, CURLOPT_HTTPGET, 1L);
            curl_easy_setopt(curl_, CURLOPT_USERAGENT, "nslibrary/" NSLIB_VERSION);
            curl_easy_setopt(curl_, CURLOPT_FOLLOWLOCATION, 0L);
            curl_easy_setopt(curl_, CURLOPT_TIMEOUT, 0L);
            curl_easy_setopt(curl_, CURLOPT_CONNECTTIMEOUT_MS, 10000L);
            curl_easy_setopt(curl_, CURLOPT_TCP_KEEPALIVE, 1L);
            curl_easy_setopt(curl_, CURLOPT_NOSIGNAL, 1L);
            curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYPEER, 0L);
            curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYHOST, 0L);
            curl_easy_setopt(curl_, CURLOPT_BUFFERSIZE, 1024L * 1024L);
            curl_easy_setopt(curl_, CURLOPT_SOCKOPTFUNCTION, sockoptLargeBuffers);
            curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, writeStream);
            curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &st);
            curl_easy_setopt(curl_, CURLOPT_HEADERFUNCTION, writeHeaders);
            curl_easy_setopt(curl_, CURLOPT_HEADERDATA, &hdrs.headers);
            curl_slist* hdr = appendHeaders(nullptr, token_, headers, false);
            curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, hdr);
            const CURLcode rc = curl_easy_perform(curl_);
            curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &status);
            curl_slist_free_all(hdr);
            if (rc != CURLE_OK && st.written == 0) {
                throw std::runtime_error(std::string("Range GET ") + path + ": " + curl_easy_strerror(rc));
            }
            if (rc != CURLE_OK) throw std::runtime_error(curl_easy_strerror(rc));
            return int(status);
        });
}

} // namespace nslib
