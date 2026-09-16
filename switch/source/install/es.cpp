#include "install/es.hpp"

#ifdef __SWITCH__

namespace nslib {
namespace {

Service g_es{};
bool g_open = false;

} // namespace

Result esInitialize() {
    if (g_open) return 0;
    Result rc = smGetService(&g_es, "es");
    if (R_FAILED(rc)) return rc;
    g_open = true;
    return 0;
}

void esExit() {
    if (!g_open) return;
    serviceClose(&g_es);
    g_open = false;
}

Result esImportTicket(const void* tik, size_t tikSize, const void* cert, size_t certSize) {
    Result rc = esInitialize();
    if (R_FAILED(rc)) return rc;
    return serviceDispatch(&g_es, 1,
        .buffer_attrs = {
            SfBufferAttr_HipcMapAlias | SfBufferAttr_In,
            SfBufferAttr_HipcMapAlias | SfBufferAttr_In,
        },
        .buffers = {
            { tik, tikSize },
            { cert, certSize },
        });
}

} // namespace nslib

#endif
