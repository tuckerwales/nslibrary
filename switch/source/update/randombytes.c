#include <stdlib.h>

/* TweetNaCl calls this from keygen. NSLibrary only verifies signatures. */
void randombytes(unsigned char* x, unsigned long long n) {
    (void)x;
    (void)n;
    abort();
}
