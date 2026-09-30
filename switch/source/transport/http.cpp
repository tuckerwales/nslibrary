#include "transport/http.hpp"

#include "api/url.hpp"
#include "transport/resume.hpp"
#include "transport/tls_pin.hpp"
#include "ui/progress.hpp"

#include <algorithm>
#include <atomic>
#include <borealis.hpp>
#include <chrono>
#include <curl/curl.h>
#include <exception>
#include <stdexcept>
#include <sys/socket.h>
#include <thread>
#include <vector>

namespace nslib {
namespace {

constexpr size_t kMaxErrorBody = 16 * 1024;

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
    CURL* curl = nullptr;
    const ByteSink* sink = nullptr;
    uint64_t offset = 0;
    uint64_t length = 0;
    uint64_t written = 0;
    long status = 0;
    bool rangeIgnored = false;
    std::string errorBody;
    std::atomic<bool>* abort = nullptr;
};

int xferinfo(void* userdata, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* st = static_cast<StreamState*>(userdata);
    if (st && st->abort && st->abort->load()) return 1;
    pumpProgressUi();
    return 0;
}

int xferinfoPumpOnly(void*, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    // No tick: it sends progress and polls events on the control transport. If this request is already on
    // that transport (job complete, state upload right after an install), its mutex is held and the tick
    // would block the UI thread forever.
    pumpProgressUi(false, false);
    return 0;
}

size_t writeStream(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* st = static_cast<StreamState*>(userdata);
    if (st->abort && st->abort->load()) return 0;
    const size_t n = size * nmemb;
    if (st->status == 0) curl_easy_getinfo(st->curl, CURLINFO_RESPONSE_CODE, &st->status);

    if (st->status < 200 || st->status >= 300) {
        // Error answers carry a JSON body. Keep it for the message; never hand it to the installer.
        if (st->errorBody.size() < kMaxErrorBody) st->errorBody.append(ptr, std::min(n, kMaxErrorBody - st->errorBody.size()));
        return n;
    }
    if (!rangeResponseOk(int(st->status), st->offset, st->length)) {
        st->rangeIgnored = true;
        return 0;
    }

    size_t take = n;
    if (st->length != UINT64_MAX) {
        const uint64_t left = st->length > st->written ? st->length - st->written : 0;
        if (take > left) take = size_t(left);
    }
    try {
        if (take) (*st->sink)(reinterpret_cast<const uint8_t*>(ptr), take);
        st->written += take;
        return n;
    } catch (...) {
        return 0;
    }
}

struct UploadState {
    const BodySource* body = nullptr;
    uint64_t left = 0;
    std::exception_ptr error;
    std::atomic<bool>* abort = nullptr;
};

size_t readUpload(char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* st = static_cast<UploadState*>(userdata);
    if (st->abort && st->abort->load()) return CURL_READFUNC_ABORT;
    const size_t want = size_t(std::min<uint64_t>(uint64_t(size) * nitems, st->left));
    if (!want) return 0;
    try {
        const size_t n = (*st->body)(reinterpret_cast<uint8_t*>(buffer), want);
        if (n == 0 || n > want) throw std::runtime_error("The upload ended before its announced length");
        st->left -= n;
        return n;
    } catch (...) {
        st->error = std::current_exception();
        return CURL_READFUNC_ABORT;
    }
}

int xferinfoUpload(void* userdata, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* st = static_cast<UploadState*>(userdata);
    if (st && st->abort && st->abort->load()) return 1;
    // Same as xferinfoPumpOnly: no tick, it could need this transport's mutex.
    pumpProgressUi(false, false);
    return 0;
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

std::string curlMessage(CURLcode rc) {
    if (rc == CURLE_SSL_PINNEDPUBKEYNOTMATCH) {
        return "The server's TLS certificate changed since pairing. If you replaced it, forget this server in "
               "Settings and connect again.";
    }
    return curl_easy_strerror(rc);
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

bool HttpTransport::isHttps() const { return lower(baseUrl_).rfind("https://", 0) == 0; }

std::string HttpTransport::lastStreamError() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastStreamError_;
}

void HttpTransport::applyCommon(const std::string& url) {
    curl_easy_reset(curl_);
    curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl_, CURLOPT_USERAGENT, "nslibrary/" NSLIB_VERSION);
    curl_easy_setopt(curl_, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(curl_, CURLOPT_CONNECTTIMEOUT_MS, connectTimeoutMs_);
    curl_easy_setopt(curl_, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(curl_, CURLOPT_NOSIGNAL, 1L);
    // The console has no CA for a self-hosted server. Trust comes from the public key pinned at pairing.
    curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYHOST, 0L);
    if (!pin_.empty() && isHttps()) curl_easy_setopt(curl_, CURLOPT_PINNEDPUBLICKEY, pin_.c_str());
    curl_easy_setopt(curl_, CURLOPT_BUFFERSIZE, 1024L * 1024L);
}

std::optional<std::string> HttpTransport::fetchPublicKeyPin() {
    if (!isHttps()) return std::nullopt;
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string url = joinUrl(baseUrl_, std::string(kDeviceApiBasePath) + "/hello");
    std::string body;
    applyCommon(url);
    curl_easy_setopt(curl_, CURLOPT_PINNEDPUBLICKEY, nullptr);
    curl_easy_setopt(curl_, CURLOPT_CERTINFO, 1L);
    curl_easy_setopt(curl_, CURLOPT_TIMEOUT_MS, 15000L);
    curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, writeBody);
    curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &body);
    // No Authorization header: this request only exists to read the certificate.
    const CURLcode rc = curl_easy_perform(curl_);
    if (rc != CURLE_OK) {
        brls::Logger::error("TLS pin probe: {}", curl_easy_strerror(rc));
        return std::nullopt;
    }
    curl_certinfo* info = nullptr;
    if (curl_easy_getinfo(curl_, CURLINFO_CERTINFO, &info) != CURLE_OK || !info || info->num_of_certs < 1) {
        brls::Logger::warning("TLS pin probe: the TLS backend returned no certificate");
        return std::nullopt;
    }
    for (curl_slist* item = info->certinfo[0]; item; item = item->next) {
        const std::string entry = item->data ? item->data : "";
        if (entry.rfind("Cert:", 0) != 0) continue;
        auto pin = pinForCertificate(entry.substr(5));
        if (pin) return pin;
    }
    brls::Logger::warning("TLS pin probe: could not read the certificate public key");
    return std::nullopt;
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
    applyCommon(url);
    curl_easy_setopt(curl_, CURLOPT_CUSTOMREQUEST, method.c_str());
    curl_easy_setopt(curl_, CURLOPT_TIMEOUT_MS, timeoutMs_);
    curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, writeBody);
    curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &out.body);
    curl_easy_setopt(curl_, CURLOPT_HEADERFUNCTION, writeHeaders);
    curl_easy_setopt(curl_, CURLOPT_HEADERDATA, &out.headers);
    curl_easy_setopt(curl_, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl_, CURLOPT_XFERINFOFUNCTION, xferinfoPumpOnly);
    curl_slist* hdr = appendHeaders(nullptr, token_, extraHeaders, jsonBody != nullptr);
    curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, hdr);
    if (jsonBody) {
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDS, jsonBody->c_str());
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE, long(jsonBody->size()));
    }
    brls::Logger::info("HTTP {} {}", method, path);
    const CURLcode rc = curl_easy_perform(curl_);
    curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &out.status);
    curl_slist_free_all(hdr);
    if (rc != CURLE_OK) {
        brls::Logger::error("HTTP {} {} curl {}", method, path, curl_easy_strerror(rc));
        throw std::runtime_error(std::string("HTTP ") + method + " " + path + ": " + curlMessage(rc));
    }
    brls::Logger::info("HTTP {} {} -> {}", method, path, out.status);
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
    // A cancel that arrived between two Range GETs still counts; only the next job clears it.
    if (abort_) throw StreamFatal("cancelled");
    lastStreamError_.clear();
    brls::Logger::info("HTTP stream {} off={} len={}", path, offset, length);
    const std::string url = joinUrl(baseUrl_, std::string(kDeviceApiBasePath) + path);

    const auto waitBeforeRetry = [&](int failures) {
        const long ms = retryDelayMs(failures);
        brls::Logger::warning("HTTP stream {} retry {} in {} ms", path, failures, ms);
        const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
        while (std::chrono::steady_clock::now() < until) {
            if (abort_) throw StreamFatal("cancelled");
            pumpProgressUi();
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    };

    return streamResuming(offset, length, sink,
        [&](uint64_t start, uint64_t remain, const ByteSink& emit) {
            auto headers = extraHeaders;
            headers.emplace_back("Range", rangeHeader(start, remain));
            StreamState st;
            st.curl = curl_;
            st.sink = &emit;
            st.offset = start;
            st.length = remain;
            st.abort = &abort_;
            HttpResponse hdrs;
            applyCommon(url);
            curl_easy_setopt(curl_, CURLOPT_HTTPGET, 1L);
            curl_easy_setopt(curl_, CURLOPT_TIMEOUT, 0L);
            // Abort a transfer that stalls below 1 KB/s for 30 s instead of hanging forever.
            curl_easy_setopt(curl_, CURLOPT_LOW_SPEED_LIMIT, 1024L);
            curl_easy_setopt(curl_, CURLOPT_LOW_SPEED_TIME, 30L);
            curl_easy_setopt(curl_, CURLOPT_SOCKOPTFUNCTION, sockoptLargeBuffers);
            curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, writeStream);
            curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &st);
            curl_easy_setopt(curl_, CURLOPT_NOPROGRESS, 0L);
            curl_easy_setopt(curl_, CURLOPT_XFERINFOFUNCTION, xferinfo);
            curl_easy_setopt(curl_, CURLOPT_XFERINFODATA, &st);
            curl_easy_setopt(curl_, CURLOPT_HEADERFUNCTION, writeHeaders);
            curl_easy_setopt(curl_, CURLOPT_HEADERDATA, &hdrs.headers);
            curl_slist* hdr = appendHeaders(nullptr, token_, headers, false);
            curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, hdr);
            const CURLcode rc = curl_easy_perform(curl_);
            curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &st.status);
            curl_slist_free_all(hdr);
            if (abort_) throw StreamFatal("cancelled");
            if (st.rangeIgnored) {
                throw StreamFatal("The server answered HTTP " + std::to_string(st.status) +
                    " instead of the requested byte range");
            }
            if (rc == CURLE_SSL_PINNEDPUBKEYNOTMATCH) throw StreamFatal(curlMessage(rc));
            if (rc != CURLE_OK) {
                throw std::runtime_error(std::string("Range GET ") + path + ": " + curlMessage(rc));
            }
            if (st.status < 200 || st.status >= 300) lastStreamError_ = st.errorBody;
            return int(st.status);
        },
        5, waitBeforeRetry);
}

HttpResponse HttpTransport::upload(const std::string& path, const std::string& contentType, uint64_t length,
    const BodySource& body)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (abort_) throw StreamFatal("cancelled");
    const std::string url = joinUrl(baseUrl_, std::string(kDeviceApiBasePath) + path);
    HttpResponse out;
    UploadState st;
    st.body = &body;
    st.left = length;
    st.abort = &abort_;
    applyCommon(url);
    curl_easy_setopt(curl_, CURLOPT_POST, 1L);
    curl_easy_setopt(curl_, CURLOPT_READFUNCTION, readUpload);
    curl_easy_setopt(curl_, CURLOPT_READDATA, &st);
    curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE_LARGE, curl_off_t(length));
    curl_easy_setopt(curl_, CURLOPT_TIMEOUT, 0L);
    // Abort an upload that stalls below 1 KB/s for 30 s instead of hanging forever.
    curl_easy_setopt(curl_, CURLOPT_LOW_SPEED_LIMIT, 1024L);
    curl_easy_setopt(curl_, CURLOPT_LOW_SPEED_TIME, 30L);
    curl_easy_setopt(curl_, CURLOPT_SOCKOPTFUNCTION, sockoptLargeBuffers);
    curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, writeBody);
    curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &out.body);
    curl_easy_setopt(curl_, CURLOPT_HEADERFUNCTION, writeHeaders);
    curl_easy_setopt(curl_, CURLOPT_HEADERDATA, &out.headers);
    curl_easy_setopt(curl_, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl_, CURLOPT_XFERINFOFUNCTION, xferinfoUpload);
    curl_easy_setopt(curl_, CURLOPT_XFERINFODATA, &st);
    curl_slist* hdr = appendHeaders(nullptr, token_, {{"Content-Type", contentType}}, false);
    // Send the body straight away rather than waiting for a 100 Continue.
    hdr = curl_slist_append(hdr, "Expect:");
    curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, hdr);
    brls::Logger::info("HTTP upload {} len={}", path, length);
    const CURLcode rc = curl_easy_perform(curl_);
    curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &out.status);
    curl_slist_free_all(hdr);
    if (st.error) std::rethrow_exception(st.error);
    if (abort_) throw StreamFatal("cancelled");
    // A server can refuse before reading the whole body (too large, bad query). Its JSON says why
    // better than curl's "failed sending data" does.
    if (rc != CURLE_OK && out.status >= 400 && !out.body.empty()) {
        brls::Logger::error("HTTP upload {} refused: {}", path, out.status);
        return out;
    }
    if (rc != CURLE_OK) {
        brls::Logger::error("HTTP upload {} curl {}", path, curl_easy_strerror(rc));
        throw std::runtime_error("HTTP POST " + path + ": " + curlMessage(rc));
    }
    brls::Logger::info("HTTP upload {} -> {}", path, out.status);
    return out;
}

} // namespace nslib
