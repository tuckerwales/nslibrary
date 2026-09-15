#include "api/json.hpp"
#include "formats/ticket.hpp"
#include "test.hpp"

using namespace nslib;

TEST(ticket_golden) {
    const auto bytes = slurpBytes(fixturePath("ticket.bin"));
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")))["ticket"];
    const TicketInfo info = parseTicket(bytes);
    CHECK_EQ(info.signatureType, 0x10004u);
    CHECK_EQ(info.rightsId, expect["rightsId"].asString());
    CHECK_EQ(info.titleId, expect["titleId"].asString());
    CHECK_EQ(int(info.keyGeneration), int(expect["keyGeneration"].asInt()));
    CHECK_EQ(info.issuer, expect["issuer"].asString());
    CHECK(info.titleKeyType == TitleKeyType::Common);
    CHECK_EQ(info.titleKeyBlock.size(), 0x100u);
}

TEST(ticket_truncated_and_unknown) {
    auto bytes = slurpBytes(fixturePath("ticket.bin"));
    bool threw = false;
    try {
        parseTicket(bytes.data(), bytes.size() - 1);
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("TRUNCATED"));
    }
    CHECK(threw);

    writeU32(bytes.data(), 0x20000);
    threw = false;
    try {
        parseTicket(bytes);
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("UNSUPPORTED"));
    }
    CHECK(threw);
}
