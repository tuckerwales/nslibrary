#include "api/url.hpp"
#include "test.hpp"

using namespace nslib;

TEST(url_normalize_ip_and_https) {
    CHECK_EQ(normalizeServerUrl("192.168.1.10"), std::string("http://192.168.1.10:8465"));
    CHECK_EQ(normalizeServerUrl("http://192.168.1.10"), std::string("http://192.168.1.10:8465"));
    CHECK_EQ(normalizeServerUrl("http://192.168.1.10:8465/"), std::string("http://192.168.1.10:8465"));
    CHECK_EQ(normalizeServerUrl("https://nslibrary.example.com"), std::string("https://nslibrary.example.com"));
    CHECK_EQ(normalizeServerUrl("  nas.local:9000  "), std::string("http://nas.local:9000"));
}

TEST(url_join_and_range) {
    CHECK_EQ(joinUrl("http://nas:8465", "/api/device/v1/hello"), std::string("http://nas:8465/api/device/v1/hello"));
    CHECK_EQ(rangeHeader(0, 100), std::string("bytes=0-99"));
    CHECK_EQ(rangeHeader(50, UINT64_MAX), std::string("bytes=50-"));
    CHECK_EQ(queryString({{"since", "3"}, {"wait", "25"}}), std::string("?since=3&wait=25"));
}

TEST(url_constants_match_shared) {
    CHECK_EQ(std::string(kDiscoveryQuery), std::string("NSLIB?1"));
    CHECK_EQ(int(kDiscoveryPort), 8466);
    CHECK_EQ(std::string(kDeviceApiBasePath), std::string("/api/device/v1"));
    CHECK_EQ(kDeviceApiProtocol, 1);
}
