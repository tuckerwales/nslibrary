#include "api/json.hpp"
#include "test.hpp"

using namespace nslib;

TEST(json_round_trip_objects_arrays_numbers) {
    const Json v = Json::parse(R"({"a":1,"b":[true,false,null,"x"],"c":-2})");
    CHECK_EQ(v["a"].asInt(), 1);
    CHECK(v["b"][0].asBool());
    CHECK(!v["b"][1].asBool());
    CHECK(v["b"][2].isNull());
    CHECK_EQ(v["b"][3].asString(), std::string("x"));
    CHECK_EQ(v["c"].asInt(), -2);
    const Json again = Json::parse(v.dump());
    CHECK_EQ(again["a"].asInt(), 1);
    CHECK_EQ(again["b"].size(), 3u + 1u);
}

TEST(json_escapes) {
    const Json v = Json::parse(R"("line\n\t\"q\"")");
    CHECK_EQ(v.asString(), std::string("line\n\t\"q\""));
}

TEST(json_trailing_rejected) {
    bool threw = false;
    try {
        Json::parse("1 2");
    } catch (const JsonError&) {
        threw = true;
    }
    CHECK(threw);
}
