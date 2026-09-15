#include "update/http_get.hpp"

#include "ui/progress.hpp"

#include <curl/curl.h>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace nslib {
namespace {

void ensureCurl() {
    static std::once_flag once;
    std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

size_t writeString(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* body = static_cast<std::string*>(userdata);
    body->append(ptr, size * nmemb);
    return size * nmemb;
}

struct StreamState {
    const std::function<void(const uint8_t*, size_t)>* sink = nullptr;
    const std::atomic<bool>* cancel = nullptr;
    std::exception_ptr sinkErr;
};

int xferinfo(void* userdata, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* st = static_cast<StreamState*>(userdata);
    if (st->cancel && st->cancel->load()) return 1;
    pumpProgressUi();
    return 0;
}

size_t writeSink(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* st = static_cast<StreamState*>(userdata);
    const size_t n = size * nmemb;
    try {
        (*st->sink)(reinterpret_cast<const uint8_t*>(ptr), n);
        return n;
    } catch (...) {
        st->sinkErr = std::current_exception();
        return 0;
    }
}

void applyCommon(CURL* curl, const std::string& url, long timeoutMs, StreamState* st) {
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, xferinfo);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, st);
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "nslibrary/" NSLIB_VERSION);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeoutMs);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
}

long perform(CURL* curl, curl_slist* hdr, const StreamState& st) {
    const CURLcode rc = curl_easy_perform(curl);
    if (st.cancel && st.cancel->load()) {
        curl_slist_free_all(hdr);
        throw std::runtime_error("cancelled");
    }
    if (st.sinkErr) {
        curl_slist_free_all(hdr);
        std::rethrow_exception(st.sinkErr);
    }
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(hdr);
    if (rc != CURLE_OK) {
        throw std::runtime_error(std::string("HTTPS GET failed: ") + curl_easy_strerror(rc));
    }
    return status;
}

} // namespace

std::string httpGetString(const std::string& url, long timeoutMs, const std::atomic<bool>* cancel) {
    ensureCurl();
    CURL* curl = curl_easy_init();
    if (!curl) throw std::runtime_error("curl_easy_init failed");
    std::string body;
    StreamState st;
    st.cancel = cancel;
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeString);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
    applyCommon(curl, url, timeoutMs, &st);
    curl_slist* hdr = curl_slist_append(nullptr, "Accept: application/vnd.github+json");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdr);
    long status = 0;
    try {
        status = perform(curl, hdr, st);
    } catch (...) {
        curl_easy_cleanup(curl);
        throw;
    }
    curl_easy_cleanup(curl);
    if (status != 200) throw std::runtime_error("HTTPS GET HTTP " + std::to_string(status));
    return body;
}

void httpGetStream(const std::string& url, const std::function<void(const uint8_t*, size_t)>& sink,
    long timeoutMs, const std::atomic<bool>* cancel)
{
    ensureCurl();
    CURL* curl = curl_easy_init();
    if (!curl) throw std::runtime_error("curl_easy_init failed");
    StreamState st;
    st.sink = &sink;
    st.cancel = cancel;
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeSink);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &st);
    applyCommon(curl, url, timeoutMs, &st);
    curl_slist* hdr = curl_slist_append(nullptr, "Accept: application/octet-stream");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdr);
    long status = 0;
    try {
        status = perform(curl, hdr, st);
    } catch (...) {
        curl_easy_cleanup(curl);
        throw;
    }
    curl_easy_cleanup(curl);
    if (status != 200) throw std::runtime_error("HTTPS GET HTTP " + std::to_string(status));
}

std::vector<uint8_t> httpGetBytes(const std::string& url, long timeoutMs, const std::atomic<bool>* cancel) {
    std::vector<uint8_t> out;
    httpGetStream(
        url,
        [&](const uint8_t* p, size_t n) {
            if (out.size() + n > 64ull * 1024ull * 1024ull) throw std::runtime_error("download is too large");
            out.insert(out.end(), p, p + n);
        },
        timeoutMs, cancel);
    return out;
}

} // namespace nslib
