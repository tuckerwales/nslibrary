#pragma once

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct TestCase {
    const char* name;
    void (*fn)();
};

inline std::vector<TestCase>& testRegistry() {
    static std::vector<TestCase> tests;
    return tests;
}

struct TestReg {
    TestReg(const char* name, void (*fn)()) { testRegistry().push_back({name, fn}); }
};

#define TEST(name) \
    void test_##name(); \
    static TestReg reg_##name(#name, test_##name); \
    void test_##name()

inline void testFail(const std::string& msg) { throw std::runtime_error(msg); }

#define CHECK(cond) \
    do { \
        if (!(cond)) testFail(std::string("CHECK(" #cond ") failed at ") + __FILE__ + ":" + std::to_string(__LINE__)); \
    } while (0)

#define CHECK_EQ(a, b) \
    do { \
        const auto _va = (a); \
        const auto _vb = (b); \
        if (!(_va == _vb)) { \
            std::ostringstream _os; \
            _os << "CHECK_EQ failed at " << __FILE__ << ":" << __LINE__ << ": " << _va << " != " << _vb; \
            testFail(_os.str()); \
        } \
    } while (0)

inline std::string slurpFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) testFail("cannot open " + path);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

inline std::vector<uint8_t> slurpBytes(const std::string& path) {
    const std::string s = slurpFile(path);
    return std::vector<uint8_t>(s.begin(), s.end());
}

inline std::string goldenPath(const char* name) {
    return std::string(GOLDEN_DIR) + "/device-api/" + name;
}

inline std::string fixturePath(const char* name) {
    return std::string(FIXTURE_DIR) + "/" + name;
}
