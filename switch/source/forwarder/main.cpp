#ifdef __SWITCH__
#include <switch.h>
#endif

/** Path the HOME-menu NSP loader jumps to. Keep this string unique so a packer can patch it. */
static const char NRO_PATH[] = "sdmc:/switch/nslibrary/nslibrary.nro";

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;
#ifdef __SWITCH__
    envSetNextLoad(NRO_PATH, "\"sdmc:/switch/nslibrary/nslibrary.nro\"");
#endif
    return 0;
}
