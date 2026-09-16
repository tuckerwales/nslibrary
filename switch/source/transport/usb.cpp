#include "transport/usb.hpp"

#include "api/json.hpp"
#include "transport/usb_frame.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>

#ifdef __SWITCH__
#include <switch.h>
#endif

namespace nslib {
namespace {

#ifdef __SWITCH__
void writeAll(const uint8_t* p, size_t n) {
    while (n) {
        const size_t w = usbCommsWrite(p, n);
        if (w == 0) throw std::runtime_error("USB write failed");
        p += w;
        n -= w;
    }
}

void readAll(uint8_t* p, size_t n) {
    while (n) {
        const size_t r = usbCommsRead(p, n);
        if (r == 0) throw std::runtime_error("USB read failed");
        p += r;
        n -= r;
    }
}
#endif

long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

} // namespace

bool UsbTransport::available() {
#ifdef __SWITCH__
    return R_SUCCEEDED(usbCommsInitialize());
#else
    return false;
#endif
}

UsbTransport::UsbTransport() {
#ifdef __SWITCH__
    if (R_FAILED(usbCommsInitialize())) throw std::runtime_error("usbCommsInitialize failed");
    lastTrafficMs_ = nowMs();
    pingThread_ = std::thread([this] { pingLoop(); });
#else
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

UsbTransport::~UsbTransport() {
    running_ = false;
    if (pingThread_.joinable()) pingThread_.join();
#ifdef __SWITCH__
    usbCommsExit();
#endif
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
            writeAll(bytes.data(), bytes.size());
            std::vector<uint8_t> resp(kUsbFrameHeaderSize);
            readAll(resp.data(), resp.size());
            const auto rh = decodeFrameHeader(resp);
            if (rh.jsonLength) {
                std::vector<uint8_t> skip(rh.jsonLength);
                readAll(skip.data(), skip.size());
            }
            if (rh.payloadLength) {
                std::vector<uint8_t> skip(size_t(rh.payloadLength));
                readAll(skip.data(), skip.size());
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
    exchangeLocked(method, path, jsonBody, extraHeaders, &status, &jsonOut, nullptr, 0);
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
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::pair<std::string, std::string>> headers = extraHeaders;
    if (length) {
        const uint64_t end = offset + length - 1;
        char range[64];
        std::snprintf(range, sizeof(range), "bytes=%llu-%llu",
            static_cast<unsigned long long>(offset), static_cast<unsigned long long>(end));
        bool hasRange = false;
        for (const auto& h : headers) {
            if (h.first == "Range" || h.first == "range") hasRange = true;
        }
        if (!hasRange) headers.emplace_back("range", range);
    }
    uint16_t status = 0;
    std::string jsonOut;
    exchangeLocked("GET", path, nullptr, headers, &status, &jsonOut, &sink, length);
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
    uint64_t expectedPayload)
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
    writeAll(frame.data(), frame.size());
    lastTrafficMs_ = nowMs();

    std::vector<uint8_t> respHdr(kUsbFrameHeaderSize);
    readAll(respHdr.data(), respHdr.size());
    const auto rh = decodeFrameHeader(respHdr);
    std::vector<uint8_t> jsonBytes(rh.jsonLength);
    if (rh.jsonLength) readAll(jsonBytes.data(), jsonBytes.size());
    *jsonOut = std::string(reinterpret_cast<char*>(jsonBytes.data()), jsonBytes.size());
    if (rh.jsonLength) {
        try {
            const Json parsed = Json::parse(*jsonOut);
            if (parsed.has("b")) *jsonOut = parsed["b"].dump();
        } catch (...) {
        }
    }
    *status = rh.status;

    uint64_t remaining = rh.payloadLength;
    std::vector<uint8_t> chunk(1 << 16);
    while (remaining) {
        const size_t n = size_t(std::min(remaining, uint64_t(chunk.size())));
        readAll(chunk.data(), n);
        if (sink) (*sink)(chunk.data(), n);
        remaining -= n;
        lastTrafficMs_ = nowMs();
    }
    lastTrafficMs_ = nowMs();
    (void)expectedPayload;
    return rh.requestId;
#else
    (void)method;
    (void)path;
    (void)jsonBody;
    (void)extraHeaders;
    (void)status;
    (void)jsonOut;
    (void)sink;
    (void)expectedPayload;
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

} // namespace nslib
