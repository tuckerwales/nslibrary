#include "api/json.hpp"
#include "test.hpp"

#include <map>

using namespace nslib;

namespace {

/** Flattens {"a":{"b":"x"}} into {"a/b": "x"}, the keys Borealis looks strings up by. */
void flatten(const Json& v, const std::string& prefix, std::map<std::string, std::string>& out) {
    if (v.isObject()) {
        for (const auto& field : v.fields()) flatten(field.second, prefix.empty() ? field.first : prefix + "/" + field.first, out);
        return;
    }
    out[prefix] = v.isString() ? v.asString() : std::string();
}

std::map<std::string, std::string> strings(const std::string& locale) {
    std::map<std::string, std::string> out;
    flatten(Json::parse(slurpFile(std::string(I18N_DIR) + "/" + locale + "/app.json")), "", out);
    return out;
}

size_t placeholders(const std::string& s) {
    size_t n = 0;
    for (size_t at = s.find("{}"); at != std::string::npos; at = s.find("{}", at + 2)) n++;
    return n;
}

} // namespace

TEST(i18n_every_locale_has_the_english_keys_and_placeholders) {
    const auto english = strings("en-US");
    for (const char* locale : {"de", "en-GB", "es", "fr", "it", "ja", "ko", "nl", "pt-BR", "ru", "zh-Hans", "zh-Hant"}) {
        const auto translated = strings(locale);
        for (const auto& [key, text] : english) {
            const auto it = translated.find(key);
            if (it == translated.end()) testFail(std::string(locale) + " is missing " + key);
            if (placeholders(it->second) != placeholders(text)) {
                testFail(std::string(locale) + " " + key + " has a different number of {} placeholders");
            }
        }
        for (const auto& entry : translated) {
            if (!english.count(entry.first)) testFail(std::string(locale) + " has " + entry.first + ", which en-US does not");
        }
    }
}
