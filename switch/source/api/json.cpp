#include "api/json.hpp"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <limits>
#include <sstream>

namespace nslib {
namespace {

const Json kNull{};

void dumpValue(const Json& v, std::string& out);

void dumpString(const std::string& s, std::string& out) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(char(c));
                }
        }
    }
    out.push_back('"');
}

void dumpValue(const Json& v, std::string& out) {
    switch (v.type()) {
        case Json::Type::Null:
            out += "null";
            break;
        case Json::Type::Bool:
            out += v.asBool() ? "true" : "false";
            break;
        case Json::Type::Number: {
            char buf[64];
            try {
                std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v.asInt()));
            } catch (const JsonError&) {
                std::snprintf(buf, sizeof(buf), "%.17g", v.asNumber());
            }
            out += buf;
            break;
        }
        case Json::Type::String:
            dumpString(v.asString(), out);
            break;
        case Json::Type::Array: {
            out.push_back('[');
            const auto& items = v.items();
            for (size_t i = 0; i < items.size(); i++) {
                if (i) out.push_back(',');
                dumpValue(items[i], out);
            }
            out.push_back(']');
            break;
        }
        case Json::Type::Object: {
            out.push_back('{');
            const auto& fields = v.fields();
            for (size_t i = 0; i < fields.size(); i++) {
                if (i) out.push_back(',');
                dumpString(fields[i].first, out);
                out.push_back(':');
                dumpValue(fields[i].second, out);
            }
            out.push_back('}');
            break;
        }
    }
}

/**
 * Arrays and objects recurse, so a hostile or corrupt body like "[[[[[…" would run the console's
 * stack into the ground before any length check fires. Real device-API bodies nest four deep.
 */
constexpr int kMaxDepth = 64;

class Parser {
public:
    explicit Parser(std::string_view in) : in_(in) {}

    Json parse() {
        skip();
        Json v = parseValue();
        skip();
        if (i_ != in_.size()) throw JsonError("trailing data after JSON value");
        return v;
    }

private:
    std::string_view in_;
    size_t i_ = 0;
    int depth_ = 0;

    /** Counts one level of array/object nesting for as long as it is in scope. */
    class Nesting {
    public:
        explicit Nesting(Parser& p) : p_(p) {
            if (++p_.depth_ > kMaxDepth) {
                p_.depth_--;
                throw JsonError("JSON nested deeper than " + std::to_string(kMaxDepth) + " levels");
            }
        }
        ~Nesting() { p_.depth_--; }
        Nesting(const Nesting&) = delete;
        Nesting& operator=(const Nesting&) = delete;

    private:
        Parser& p_;
    };

    bool eof() const { return i_ >= in_.size(); }
    char peek() const { return eof() ? 0 : in_[i_]; }
    char get() {
        if (eof()) throw JsonError("unexpected end of JSON");
        return in_[i_++];
    }
    void skip() {
        while (!eof() && std::isspace(static_cast<unsigned char>(in_[i_]))) i_++;
    }

    Json parseValue() {
        skip();
        if (eof()) throw JsonError("unexpected end of JSON");
        const char c = peek();
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return parseNumber();
        throw JsonError(std::string("unexpected character '") + c + "'");
    }

    Json parseNull() {
        if (in_.substr(i_, 4) != "null") throw JsonError("invalid null");
        i_ += 4;
        return Json::null();
    }

    Json parseBool() {
        if (in_.substr(i_, 4) == "true") {
            i_ += 4;
            return Json::boolean(true);
        }
        if (in_.substr(i_, 5) == "false") {
            i_ += 5;
            return Json::boolean(false);
        }
        throw JsonError("invalid boolean");
    }

    Json parseNumber() {
        const size_t start = i_;
        if (peek() == '-') i_++;
        if (eof() || !std::isdigit(static_cast<unsigned char>(peek()))) throw JsonError("invalid number");
        if (peek() == '0') {
            i_++;
        } else {
            while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) i_++;
        }
        bool isInt = true;
        if (!eof() && peek() == '.') {
            isInt = false;
            i_++;
            if (eof() || !std::isdigit(static_cast<unsigned char>(peek()))) throw JsonError("invalid number");
            while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) i_++;
        }
        if (!eof() && (peek() == 'e' || peek() == 'E')) {
            isInt = false;
            i_++;
            if (!eof() && (peek() == '+' || peek() == '-')) i_++;
            if (eof() || !std::isdigit(static_cast<unsigned char>(peek()))) throw JsonError("invalid number");
            while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) i_++;
        }
        const std::string text(in_.substr(start, i_ - start));
        if (isInt) {
            try {
                size_t idx = 0;
                const long long v = std::stoll(text, &idx, 10);
                if (idx != text.size()) throw JsonError("invalid number");
                return Json::number(int64_t(v));
            } catch (const JsonError&) {
                throw;
            } catch (...) {
                throw JsonError("integer out of range: " + text);
            }
        }
        try {
            return Json::number(std::stod(text));
        } catch (...) {
            throw JsonError("number out of range: " + text);
        }
    }

    uint32_t parseHex4() {
        uint32_t code = 0;
        for (int n = 0; n < 4; n++) {
            const char h = get();
            code <<= 4;
            if (h >= '0' && h <= '9') code += uint32_t(h - '0');
            else if (h >= 'a' && h <= 'f') code += uint32_t(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') code += uint32_t(h - 'A' + 10);
            else throw JsonError("invalid \\u escape");
        }
        return code;
    }

    static void appendUtf8(std::string& out, uint32_t code) {
        if (code < 0x80) {
            out.push_back(char(code));
        } else if (code < 0x800) {
            out.push_back(char(0xc0 | (code >> 6)));
            out.push_back(char(0x80 | (code & 0x3f)));
        } else if (code < 0x10000) {
            out.push_back(char(0xe0 | (code >> 12)));
            out.push_back(char(0x80 | ((code >> 6) & 0x3f)));
            out.push_back(char(0x80 | (code & 0x3f)));
        } else {
            out.push_back(char(0xf0 | (code >> 18)));
            out.push_back(char(0x80 | ((code >> 12) & 0x3f)));
            out.push_back(char(0x80 | ((code >> 6) & 0x3f)));
            out.push_back(char(0x80 | (code & 0x3f)));
        }
    }

    Json parseString() {
        if (get() != '"') throw JsonError("expected string");
        std::string out;
        while (!eof()) {
            const char c = get();
            if (c == '"') return Json::string(std::move(out));
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            const char e = get();
            switch (e) {
                case '"':
                case '\\':
                case '/': out.push_back(e); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    uint32_t code = parseHex4();
                    // A non-ASCII title name arrives as a surrogate pair; pairing them keeps the
                    // UTF-8 valid so nanovg does not draw the name as replacement boxes.
                    if (code >= 0xd800 && code <= 0xdbff && in_.substr(i_, 2) == "\\u") {
                        const size_t mark = i_;
                        i_ += 2;
                        const uint32_t low = parseHex4();
                        if (low >= 0xdc00 && low <= 0xdfff) {
                            code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                        } else {
                            i_ = mark;
                        }
                    }
                    // An unpaired surrogate has no UTF-8 encoding; U+FFFD keeps the string usable.
                    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
                    appendUtf8(out, code);
                    break;
                }
                default: throw JsonError("invalid string escape");
            }
        }
        throw JsonError("unterminated string");
    }

    Json parseArray() {
        Nesting nest(*this);
        if (get() != '[') throw JsonError("expected array");
        Json arr = Json::array();
        skip();
        if (peek() == ']') {
            get();
            return arr;
        }
        while (true) {
            arr.push(parseValue());
            skip();
            const char c = get();
            if (c == ']') return arr;
            if (c != ',') throw JsonError("expected comma in array");
            skip();
        }
    }

    Json parseObject() {
        Nesting nest(*this);
        if (get() != '{') throw JsonError("expected object");
        Json obj = Json::object();
        skip();
        if (peek() == '}') {
            get();
            return obj;
        }
        while (true) {
            skip();
            Json key = parseString();
            skip();
            if (get() != ':') throw JsonError("expected colon in object");
            obj.set(key.asString(), parseValue());
            skip();
            const char c = get();
            if (c == '}') return obj;
            if (c != ',') throw JsonError("expected comma in object");
        }
    }
};

} // namespace

Json Json::boolean(bool v) {
    Json j;
    j.type_ = Type::Bool;
    j.bool_ = v;
    return j;
}

Json Json::number(int64_t v) {
    Json j;
    j.type_ = Type::Number;
    j.isInt_ = true;
    j.int_ = v;
    j.real_ = double(v);
    return j;
}

Json Json::number(uint64_t v) {
    if (v > uint64_t(std::numeric_limits<int64_t>::max())) {
        Json j;
        j.type_ = Type::Number;
        j.isInt_ = false;
        j.real_ = double(v);
        return j;
    }
    return number(int64_t(v));
}

Json Json::number(double v) {
    Json j;
    j.type_ = Type::Number;
    j.isInt_ = false;
    // NaN and infinity have no JSON form and int64_t(v) would be undefined behaviour.
    j.real_ = std::isfinite(v) ? v : 0.0;
    j.int_ = int64_t(j.real_);
    return j;
}

Json Json::string(std::string v) {
    Json j;
    j.type_ = Type::String;
    j.str_ = std::move(v);
    return j;
}

Json Json::array() {
    Json j;
    j.type_ = Type::Array;
    return j;
}

Json Json::object() {
    Json j;
    j.type_ = Type::Object;
    return j;
}

Json Json::parse(std::string_view text) { return Parser(text).parse(); }

std::string Json::dump() const {
    std::string out;
    dumpValue(*this, out);
    return out;
}

bool Json::asBool() const {
    if (type_ != Type::Bool) throw JsonError("expected boolean");
    return bool_;
}

int64_t Json::asInt() const {
    if (type_ != Type::Number) throw JsonError("expected number");
    if (!isInt_) throw JsonError("expected integer");
    return int_;
}

uint64_t Json::asUint() const {
    const int64_t v = asInt();
    if (v < 0) throw JsonError("expected unsigned integer");
    return uint64_t(v);
}

double Json::asNumber() const {
    if (type_ != Type::Number) throw JsonError("expected number");
    return isInt_ ? double(int_) : real_;
}

const std::string& Json::asString() const {
    if (type_ != Type::String) throw JsonError("expected string");
    return str_;
}

size_t Json::size() const {
    if (type_ == Type::Array) return arr_.size();
    if (type_ == Type::Object) return obj_.size();
    throw JsonError("size() on non-container");
}

const Json& Json::at(size_t i) const {
    if (type_ != Type::Array) throw JsonError("expected array");
    if (i >= arr_.size()) throw JsonError("array index out of range");
    return arr_[i];
}

const Json& Json::at(const std::string& key) const {
    if (type_ != Type::Object) throw JsonError("expected object");
    for (const auto& f : obj_) {
        if (f.first == key) return f.second;
    }
    return kNull;
}

bool Json::has(const std::string& key) const {
    if (type_ != Type::Object) return false;
    for (const auto& f : obj_) {
        if (f.first == key) return true;
    }
    return false;
}

const std::vector<Json>& Json::items() const {
    if (type_ != Type::Array) throw JsonError("expected array");
    return arr_;
}

const std::vector<std::pair<std::string, Json>>& Json::fields() const {
    if (type_ != Type::Object) throw JsonError("expected object");
    return obj_;
}

Json& Json::push(Json v) {
    if (type_ != Type::Array) throw JsonError("push on non-array");
    arr_.push_back(std::move(v));
    return arr_.back();
}

Json& Json::set(std::string key, Json v) {
    if (type_ != Type::Object) throw JsonError("set on non-object");
    for (auto& f : obj_) {
        if (f.first == key) {
            f.second = std::move(v);
            return f.second;
        }
    }
    obj_.push_back({std::move(key), std::move(v)});
    return obj_.back().second;
}

} // namespace nslib
