#include "api/protocol.hpp"
#include "test.hpp"

using namespace nslib;

TEST(protocol_pair_request_golden) {
    const auto r = parsePairRequest(slurpFile(goldenPath("pair-request.json")));
    CHECK_EQ(r.code, std::string("482913"));
    CHECK_EQ(r.device.deviceUuid, std::string("3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d"));
    CHECK_EQ(r.device.name, std::string("Living room Switch"));
    CHECK_EQ(r.device.fw, std::string("19.0.1"));
    CHECK_EQ(r.device.amsVersion, std::string("1.8.0"));
    CHECK_EQ(r.device.appVersion, std::string("0.1.0"));
    const auto again = parsePairRequest(encodePairRequest(r).dump());
    CHECK_EQ(again.code, r.code);
    CHECK_EQ(again.device.deviceUuid, r.device.deviceUuid);
}

TEST(protocol_pair_response_golden) {
    const auto r = parsePairResponse(slurpFile(goldenPath("pair-response.json")));
    CHECK_EQ(r.token, std::string("q3J9mZx7P0vL2cT8rW5yN1bK4hG6dF0sA9eU3iO7pQ2"));
    CHECK_EQ(r.deviceId, 1);
    CHECK_EQ(r.serverName, std::string("nas"));
}

TEST(protocol_hello_golden) {
    const auto r = parseHello(slurpFile(goldenPath("hello-response.json")));
    CHECK_EQ(r.serverId, std::string("b7e1f0c2-5a9d-4c3e-8f61-2d4a7b9c0e15"));
    CHECK_EQ(r.proto, 1);
    CHECK_EQ(r.catalogRev, 42);
    CHECK_EQ(r.caps.size(), 3u);
    CHECK_EQ(r.caps[0], std::string("ncz-block"));
}

TEST(protocol_state_golden) {
    const auto s = parseDeviceState(slurpFile(goldenPath("state-request.json")));
    CHECK_EQ(s.fw, std::string("19.0.1"));
    CHECK(s.sd.has_value());
    CHECK_EQ(s.sd->free, 182536110080ull);
    CHECK_EQ(s.nand.total, 26830438400ull);
    CHECK_EQ(s.titles.size(), 3u);
    CHECK_EQ(s.titles[2].type, std::string("addon"));
    CHECK_EQ(s.titles[2].storage, std::string("nand"));
    const auto again = parseDeviceState(encodeDeviceState(s).dump());
    CHECK_EQ(again.titles.size(), 3u);
    CHECK_EQ(again.sd->total, s.sd->total);
}

TEST(protocol_catalog_golden) {
    const auto c = parseCatalog(slurpFile(goldenPath("catalog-response.json")));
    CHECK_EQ(c.rev, 42);
    CHECK(!c.full);
    CHECK(!c.next.has_value());
    CHECK_EQ(c.del.size(), 1u);
    CHECK_EQ(c.apps.size(), 1u);
    const auto& app = c.apps[0];
    CHECK_EQ(app.id, std::string("0100000000010000"));
    CHECK_EQ(app.name, std::string("Example Homebrew Game"));
    CHECK_EQ(app.publisher, std::string("Example Publisher"));
    CHECK(app.iconRev.has_value());
    CHECK_EQ(*app.iconRev, 3);
    CHECK(app.base.has_value());
    CHECK_EQ(app.base->format, std::string("nsz"));
    CHECK_EQ(app.base->contentMetaId, 11);
    CHECK_EQ(app.updates.size(), 2u);
    CHECK_EQ(app.updates[0].version, 393216u);
    CHECK_EQ(app.dlc.size(), 1u);
    CHECK_EQ(app.dlc[0].name, std::string("Bonus Pack"));
}

TEST(protocol_events_golden) {
    const auto e = parseEvents(slurpFile(goldenPath("events-response.json")));
    CHECK_EQ(e.cursor, std::string("17"));
    CHECK_EQ(e.ev.size(), 3u);
    CHECK_EQ(e.ev[0].t, std::string("job.queued"));
    CHECK(e.ev[0].job.has_value());
    CHECK_EQ(e.ev[0].job->id, 7);
    CHECK_EQ(e.ev[0].job->format, std::string("nsp"));
    CHECK_EQ(e.ev[1].t, std::string("job.cancel"));
    CHECK_EQ(e.ev[1].id, 6);
    CHECK_EQ(e.ev[2].t, std::string("catalog"));
    CHECK_EQ(e.ev[2].rev, 43);
}

TEST(protocol_progress_golden) {
    const auto p = parseJobProgress(slurpFile(goldenPath("job-progress-request.json")));
    CHECK_EQ(p.phase, std::string("content"));
    CHECK(p.item.has_value());
    CHECK_EQ(p.done, 268435456ull);
    CHECK_EQ(p.total, 734003200ull);
    CHECK(p.bps > 10000000);
    const auto again = parseJobProgress(encodeJobProgress(p).dump());
    CHECK_EQ(again.phase, p.phase);
    CHECK_EQ(again.done, p.done);
}

TEST(protocol_error_golden) {
    const auto e = parseError(Json::parse(slurpFile(goldenPath("error-body.json"))));
    CHECK_EQ(e.code, std::string("PAIR_CODE_EXPIRED"));
    CHECK_EQ(e.msg, std::string("Pairing code has expired"));
}
