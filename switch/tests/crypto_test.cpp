#include "api/json.hpp"
#include "formats/crypto.hpp"
#include "test.hpp"

#include <cstring>
#include <cstdlib>

using namespace nslib;

TEST(sha256_empty) {
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    const auto d = sha256("", 0);
    CHECK_EQ(hexLower(d.data(), d.size()), expect["crypto"]["emptySha256"].asString());
}

TEST(aes_ctr_unaligned) {
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    const auto& c = expect["crypto"];
    auto key = slurpBytes(fixturePath("nca.bin")); // just to have a vector helper; parse hex instead
    (void)key;
    const std::string keyHex = c["ctrKey"].asString();
    const std::string nonceHex = c["ctrNonce"].asString();
    const std::string plainHex = c["ctrPlain"].asString();
    const std::string outHex = c["ctrOut"].asString();

    auto fromHex = [](const std::string& h) {
        std::vector<uint8_t> v(h.size() / 2);
        for (size_t i = 0; i < v.size(); i++) {
            v[i] = uint8_t(strtoul(h.substr(i * 2, 2).c_str(), nullptr, 16));
        }
        return v;
    };
    auto keyB = fromHex(keyHex);
    auto nonce = fromHex(nonceHex);
    auto plain = fromHex(plainHex);
    uint8_t counter[16]{};
    std::memcpy(counter, nonce.data(), 8);
    aesCtrXor(keyB.data(), counter, uint64_t(c["ctrOffset"].asUint()), plain.data(), plain.size());
    CHECK_EQ(hexLower(plain.data(), plain.size()), outHex);
}

TEST(sha256_streaming_matches_oneshot) {
    const auto bytes = slurpBytes(fixturePath("nca.bin"));
    const auto one = sha256(bytes.data(), bytes.size());
    Sha256 h;
    h.update(bytes.data(), 100);
    h.update(bytes.data() + 100, bytes.size() - 100);
    const auto two = h.digest();
    CHECK_EQ(hexLower(one.data(), 32), hexLower(two.data(), 32));
}
