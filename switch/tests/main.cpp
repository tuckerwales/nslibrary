#include "test.hpp"

#include <iostream>

int main() {
    int failed = 0;
    int passed = 0;
    for (const auto& t : testRegistry()) {
        try {
            t.fn();
            std::cout << "ok   " << t.name << "\n";
            passed++;
        } catch (const std::exception& e) {
            std::cout << "FAIL " << t.name << ": " << e.what() << "\n";
            failed++;
        }
    }
    std::cout << passed << " passed, " << failed << " failed\n";
    return failed ? 1 : 0;
}
