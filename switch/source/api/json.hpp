#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace nslib {

class JsonError : public std::runtime_error {
public:
    explicit JsonError(const std::string& message) : std::runtime_error(message) {}
};

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() = default;
    static Json null() { return Json(); }
    static Json boolean(bool v);
    static Json number(int64_t v);
    static Json number(uint64_t v);
    static Json number(double v);
    static Json string(std::string v);
    static Json array();
    static Json object();

    static Json parse(std::string_view text);
    std::string dump() const;

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isBool() const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray() const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    bool asBool() const;
    int64_t asInt() const;
    uint64_t asUint() const;
    double asNumber() const;
    const std::string& asString() const;

    size_t size() const;
    const Json& at(size_t i) const;
    const Json& at(const std::string& key) const;
    const Json& operator[](size_t i) const { return at(i); }
    const Json& operator[](const std::string& key) const { return at(key); }
    bool has(const std::string& key) const;
    const std::vector<Json>& items() const;
    const std::vector<std::pair<std::string, Json>>& fields() const;

    Json& push(Json v);
    Json& set(std::string key, Json v);

private:
    Type type_ = Type::Null;
    bool bool_ = false;
    bool isInt_ = true;
    int64_t int_ = 0;
    double real_ = 0;
    std::string str_;
    std::vector<Json> arr_;
    std::vector<std::pair<std::string, Json>> obj_;
};

} // namespace nslib
