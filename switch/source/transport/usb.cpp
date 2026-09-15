#include "transport/usb.hpp"

#include "api/json.hpp"
#include "api/url.hpp"
#include "transport/resume.hpp"
#include "transport/usb_ds.hpp"
#include "transport/usb_frame.hpp"
#include "ui/progress.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <stdexcept>
#include <vector>

#ifdef __SWITCH__
#include <malloc.h>
#endif

namespace nslib {
namespace {

uint64_t timeoutNs(long ms) {
    if (ms <= 0) return UINT64_MAX;
    return uint64_t(ms) * 1000000ull;
}

constexpr size_t kPayloadBuffer = 1 << 20;
constexpr size_t kMaxErrorBody = 16 * 1024;

#ifdef __SWITCH__
void writeAll(const uint8_t* p, size_t n, long ms, long readyMs) { usbDsWriteAll(p, n, timeoutNs(ms), timeoutNs(readyMs)); }
void readAll(uint8_t* p, size_t n, long ms, long readyMs) { usbDsReadAll(p, n, timeoutNs(ms), timeoutNs(readyMs)); }
#endif

long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

} // namespace

bool UsbTransport::available() { return usbDsAvailable(); }

UsbTransport::UsbTransport() {
#ifdef __SWITCH__
    // usbDs transfers go straight to page-aligned memory; anything else is copied through a 4 KB bounce buffer.
    buffer_ = static_cast<uint8_t*>(memalign(0x1000, kPayloadBuffer));
    if (!buffer_) throw std::runtime_error("Out of memory for the USB buffer");
    usbDsStart();
    lastTrafficMs_ = nowMs();
    pingThread_ = std::thread([this] { pingLoop(); });
#else
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

UsbTransport::~UsbTransport() {
    running_ = false;
    usbDsCancel();
    if (pingThread_.joinable()) pingThread_.join();
#ifdef __SWITCH__
    usbDsStop();
    free(buffer_);
#endif
}

std::string UsbTransport::lastStreamError() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastStreamError_;
}

void UsbTransport::pingLoop() {
    while (running_) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        if (!running_) break;
        if (nowMs() - lastTrafficMs_.load() < 5000) continue;
        std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
        if (!lock.owns_lock()) continue;
        try {
#ifdef __SWITCH__
            FrameHeader h;
            h.kind = FrameKind::Ping;
            h.requestId = nextId_++;
            auto bytes = encodeFrameHeader(h);
            writeAll(bytes.data(), bytes.size(), timeoutMs_, readyTimeoutMs_);
            std::vector<uint8_t> resp(kUsbFrameHeaderSize);
            readAll(resp.data(), resp.size(), timeoutMs_, readyTimeoutMs_);
            const auto rh = decodeFrameHeader(resp);
            if (rh.jsonLength) {
                std::vector<uint8_t> skip(rh.jsonLength);
                readAll(skip.data(), skip.size(), timeoutMs_, readyTimeoutMs_);
            }
            uint64_t left = rh.payloadLength;
            while (left) {
                const size_t n = size_t(std::min<uint64_t>(left, kPayloadBuffer));
                readAll(buffer_, n, timeoutMs_, readyTimeoutMs_);
                left -= n;
            }
            lastTrafficMs_ = nowMs();
#endif
        } catch (...) {
        }
    }
}

HttpResponse UsbTransport::request(
    const std::string& method,
    const std::string& path,
    const std::string* jsonBody,
    const std::vector<std::pair<std::string, std::string>>& extraHeaders)
{
    std::lock_guard<std::mutex> lock(mutex_);
    uint16_t status = 0;
    std::string jsonOut;
    exchangeLocked(method, path, jsonBody, extraHeaders, &status, &jsonOut, nullptr, 0, 0);
    HttpResponse res;
    res.status = status;
    res.body = std::move(jsonOut);
    return res;
}

int UsbTransport::stream(
    const std::string& path,
    uint64_t offset,
    uint64_t length,
    const std::vector<std::pair<std::string, std::string>>& extraHeaders,
    const std::function<void(const uint8_t*, size_t)>& sink)
{
    if (abort_) throw StreamFatal("cancelled");
    {
        std::lock_guard<std::mutex> lock(mutex_);
        lastStreamError_.clear();
    }

    const auto streamRange = [&](uint64_t off, uint64_t len, uint64_t& got) {
        std::lock_guard<std::mutex> lock(mutex_);
        return streamResuming(off, len,
            [&](const uint8_t* p, size_t n) {
                sink(p, n);
                got += n;
            },
            [&](uint64_t start, uint64_t remain, const ByteSink& emit) {
                std::vector<std::pair<std::string, std::string>> headers = extraHeaders;
                bool hasRange = false;
                for (const auto& h : headers) {
                    if (h.first == "Range" || h.first == "range") hasRange = true;
                }
                if (!hasRange) headers.emplace_back("range", rangeHeader(start, remain));
                uint16_t status = 0;
                std::string jsonOut;
                exchangeLocked("GET", path, nullptr, headers, &status, &jsonOut, &emit, start, remain);
                if (status < 200 || status >= 300) lastStreamError_ = jsonOut;
                return int(status);
            },
            3);
    };

    if (length == UINT64_MAX) {
        uint64_t got = 0;
        return streamRange(offset, length, got);
    }

    uint64_t done = 0;
    int status = 206;
    while (done < length) {
        if (abort_) throw StreamFatal("cancelled");
        const uint64_t n = std::min(kStreamChunkBytes, length - done);
        uint64_t got = 0;
        status = streamRange(offset + done, n, got);
        if (status < 200 || status >= 300) return status;
        done += got;
        if (got < n) break;  // source ended early
        if (done < length && chunkHook_) chunkHook_();
    }
    return status;
}

uint32_t UsbTransport::exchangeLocked(
    const std::string& method,
    const std::string& path,
    const std::string* jsonBody,
    const std::vector<std::pair<std::string, std::string>>& extraHeaders,
    uint16_t* status,
    std::string* jsonOut,
    const std::function<void(const uint8_t*, size_t)>* sink,
    uint64_t offset,
    uint64_t length)
{
#ifdef __SWITCH__
    Json req = Json::object();
    req.set("m", Json::string(method));
    req.set("p", Json::string(path));
    Json h = Json::object();
    if (!token_.empty()) h.set("authorization", Json::string("Bearer " + token_));
    for (const auto& kv : extraHeaders) h.set(kv.first, Json::string(kv.second));
    if (h.size() > 0) req.set("h", std::move(h));
    if (jsonBody && !jsonBody->empty()) req.set("b", Json::parse(*jsonBody));
    const std::string jsonText = req.dump();

    FrameHeader hdr;
    hdr.kind = FrameKind::Request;
    hdr.requestId = nextId_++;
    const auto frame = encodeFrame(hdr, reinterpret_cast<const uint8_t*>(jsonText.data()), jsonText.size(), nullptr, 0);
    writeAll(frame.data(), frame.size(), timeoutMs_, readyTimeoutMs_);
    lastTrafficMs_ = nowMs();

    std::vector<uint8_t> respHdr(kUsbFrameHeaderSize);
    readAll(respHdr.data(), respHdr.size(), timeoutMs_, readyTimeoutMs_);
    const auto rh = decodeFrameHeader(respHdr);
    std::vector<uint8_t> jsonBytes(rh.jsonLength);
    if (rh.jsonLength) readAll(jsonBytes.data(), jsonBytes.size(), timeoutMs_, readyTimeoutMs_);
    *jsonOut = std::string(reinterpret_cast<char*>(jsonBytes.data()), jsonBytes.size());
    if (rh.jsonLength) {
        try {
            const Json parsed = Json::parse(*jsonOut);
            if (parsed.has("b")) *jsonOut = parsed["b"].dump();
        } catch (...) {
        }
    }
    *status = rh.status;

    const bool ok = rh.status >= 200 && rh.status < 300;
    // Error payloads and cancelled transfers are still read to the end so the next frame lines up.
    bool deliver = sink && ok;
    bool rangeIgnored = false;
    if (deliver && !rangeResponseOk(rh.status, offset, length)) {
        deliver = false;
        rangeIgnored = true;
    }
    if (!ok && rh.payloadLength && jsonOut->empty()) jsonOut->reserve(size_t(std::min<uint64_t>(rh.payloadLength, kMaxErrorBody)));

    uint64_t remaining = rh.payloadLength;
    uint64_t delivered = 0;
    std::exception_ptr sinkErr;
    while (remaining) {
        const size_t n = size_t(std::min<uint64_t>(remaining, kPayloadBuffer));
        readAll(buffer_, n, timeoutMs_, readyTimeoutMs_);
        if (deliver && abort_) deliver = false;
        if (deliver) {
            size_t take = n;
            if (length != UINT64_MAX && delivered + take > length) take = size_t(length - delivered);
            try {
                if (take) (*sink)(buffer_, take);
            } catch (...) {
                // Keep reading so the next frame header lines up, then report the sink's error.
                sinkErr = std::current_exception();
                deliver = false;
            }
            delivered += take;
        }
        remaining -= n;
        lastTrafficMs_ = nowMs();
        pumpProgressUi();
    }
    lastTrafficMs_ = nowMs();
    if (sinkErr) std::rethrow_exception(sinkErr);
    if (sink && abort_) throw StreamFatal("cancelled");
    if (rangeIgnored) {
        throw StreamFatal("The server answered USB status " + std::to_string(rh.status) +
            " instead of the requested byte range");
    }
    return rh.requestId;
#else
    (void)method;
    (void)path;
    (void)jsonBody;
    (void)extraHeaders;
    (void)status;
    (void)jsonOut;
    (void)sink;
    (void)offset;
    (void)length;
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

} // namespace nslib
