#include "api/json.hpp"
#include "test.hpp"
#include "transport/usb_frame.hpp"

#include <cstdlib>

using namespace nslib;

static std::vector<uint8_t> fromHex(const std::string& hex) {
    std::vector<uint8_t> out(hex.size() / 2);
    for (size_t i = 0; i < out.size(); i++) {
        out[i] = uint8_t(strtoul(hex.substr(i * 2, 2).c_str(), nullptr, 16));
    }
    return out;
}

TEST(usb_frame_golden_vectors) {
    const auto goldens = Json::parse(slurpFile(std::string(GOLDEN_DIR) + "/usb/frames.json"));
    CHECK(goldens.isArray());
    for (const auto& frame : goldens.items()) {
        const auto expect = fromHex(frame["hex"].asString());
        const auto header = decodeFrameHeader(expect);
        CHECK_EQ(header.requestId, uint32_t(frame["requestId"].asUint()));
        CHECK_EQ(header.status, uint16_t(frame["status"].asUint()));
        CHECK_EQ(header.flags, uint8_t(frame["flags"].asUint()));
        const int expectKind = frame["kind"].asString() == "Request"     ? 1
            : frame["kind"].asString() == "Response" ? 2
            : frame["kind"].asString() == "Cancel"   ? 3
            : frame["kind"].asString() == "Ping"     ? 4
                                                     : 5;
        CHECK_EQ(int(header.kind), expectKind);

        std::string jsonText;
        if (!frame["json"].isNull()) jsonText = frame["json"].dump();
        const auto payloadHex = frame["payloadHex"].asString();
        const auto payload = fromHex(payloadHex);
        FrameHeader h;
        h.kind = header.kind;
        h.flags = header.flags;
        h.requestId = header.requestId;
        h.status = header.status;
        const auto encoded = encodeFrame(h, reinterpret_cast<const uint8_t*>(jsonText.data()), jsonText.size(),
            payload.empty() ? nullptr : payload.data(), payload.size());
        CHECK_EQ(hexLower(encoded.data(), encoded.size()), frame["hex"].asString());
    }
}

TEST(usb_frame_rejects_short_foreign_future) {
    FrameHeader ping;
    ping.kind = FrameKind::Ping;
    ping.requestId = 1;
    auto valid = encodeFrameHeader(ping);

    bool threw = false;
    try {
        decodeFrameHeader(valid.data(), kUsbFrameHeaderSize - 1);
    } catch (const FrameError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("SHORT_HEADER"));
    }
    CHECK(threw);

    threw = false;
    valid[0] = 'X';
    try {
        decodeFrameHeader(valid);
    } catch (const FrameError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_MAGIC"));
    }
    CHECK(threw);

    valid = encodeFrameHeader(ping);
    writeU16(valid.data() + 4, 2);
    threw = false;
    try {
        decodeFrameHeader(valid);
    } catch (const FrameError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_VERSION"));
    }
    CHECK(threw);

    valid = encodeFrameHeader(ping);
    valid[6] = 9;
    threw = false;
    try {
        decodeFrameHeader(valid);
    } catch (const FrameError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_KIND"));
    }
    CHECK(threw);

    valid = encodeFrameHeader(ping);
    writeU64(valid.data() + 0x18, 1ull << 60);
    threw = false;
    try {
        decodeFrameHeader(valid);
    } catch (const FrameError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TOO_LARGE"));
    }
    CHECK(threw);
}

TEST(usb_frame_round_trip_large_payload_length) {
    FrameHeader h;
    h.kind = FrameKind::Response;
    h.flags = 1;
    h.requestId = 0xfffffffe;
    h.status = 206;
    h.jsonLength = 123;
    h.payloadLength = 16ull * 1024ull * 1024ull * 1024ull + 7;
    const auto again = decodeFrameHeader(encodeFrameHeader(h));
    CHECK_EQ(again.requestId, h.requestId);
    CHECK_EQ(again.payloadLength, h.payloadLength);
    CHECK_EQ(again.status, h.status);
    CHECK_EQ(again.flags, h.flags);
}
