#include "transport/usb_ds.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>

#ifdef __SWITCH__
#include <malloc.h>
#include <switch.h>
#endif

namespace nslib {
namespace {

#ifdef __SWITCH__

constexpr u16 kVid = 0x057e;
constexpr u16 kPid = 0x3000;
constexpr size_t kBounce = 0x1000;

UsbDsInterface* g_interface = nullptr;
UsbDsEndpoint* g_epIn = nullptr;
UsbDsEndpoint* g_epOut = nullptr;
u8* g_bounceIn = nullptr;
u8* g_bounceOut = nullptr;
std::mutex g_mu;
bool g_started = false;

void fail(const char* what, Result rc) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "%s failed (0x%X)", what, rc);
    throw std::runtime_error(buf);
}

Result initInterface5x() {
    Result rc = 0;
    struct usb_interface_descriptor interface_descriptor = {
        .bLength = USB_DT_INTERFACE_SIZE,
        .bDescriptorType = USB_DT_INTERFACE,
        .bInterfaceNumber = 4,
        .bNumEndpoints = 2,
        .bInterfaceClass = USB_CLASS_VENDOR_SPEC,
        .bInterfaceSubClass = USB_CLASS_VENDOR_SPEC,
        .bInterfaceProtocol = USB_CLASS_VENDOR_SPEC,
    };
    struct usb_endpoint_descriptor endpoint_descriptor_in = {
        .bLength = USB_DT_ENDPOINT_SIZE,
        .bDescriptorType = USB_DT_ENDPOINT,
        .bEndpointAddress = USB_ENDPOINT_IN,
        .bmAttributes = USB_TRANSFER_TYPE_BULK,
        .wMaxPacketSize = 0x40,
    };
    struct usb_endpoint_descriptor endpoint_descriptor_out = {
        .bLength = USB_DT_ENDPOINT_SIZE,
        .bDescriptorType = USB_DT_ENDPOINT,
        .bEndpointAddress = USB_ENDPOINT_OUT,
        .bmAttributes = USB_TRANSFER_TYPE_BULK,
        .wMaxPacketSize = 0x40,
    };
    struct usb_ss_endpoint_companion_descriptor endpoint_companion = {
        .bLength = sizeof(struct usb_ss_endpoint_companion_descriptor),
        .bDescriptorType = USB_DT_SS_ENDPOINT_COMPANION,
        .bMaxBurst = 0x0F,
        .bmAttributes = 0x00,
        .wBytesPerInterval = 0x00,
    };

    rc = usbDsRegisterInterface(&g_interface);
    if (R_FAILED(rc)) return rc;
    interface_descriptor.bInterfaceNumber = g_interface->interface_index;
    endpoint_descriptor_in.bEndpointAddress += interface_descriptor.bInterfaceNumber + 1;
    endpoint_descriptor_out.bEndpointAddress += interface_descriptor.bInterfaceNumber + 1;

    auto append = [&](UsbDeviceSpeed speed, const void* data, size_t size) -> Result {
        return usbDsInterface_AppendConfigurationData(g_interface, speed, const_cast<void*>(data), size);
    };

    rc = append(UsbDeviceSpeed_Full, &interface_descriptor, USB_DT_INTERFACE_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Full, &endpoint_descriptor_in, USB_DT_ENDPOINT_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Full, &endpoint_descriptor_out, USB_DT_ENDPOINT_SIZE);

    endpoint_descriptor_in.wMaxPacketSize = 0x200;
    endpoint_descriptor_out.wMaxPacketSize = 0x200;
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_High, &interface_descriptor, USB_DT_INTERFACE_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_High, &endpoint_descriptor_in, USB_DT_ENDPOINT_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_High, &endpoint_descriptor_out, USB_DT_ENDPOINT_SIZE);

    endpoint_descriptor_in.wMaxPacketSize = 0x400;
    endpoint_descriptor_out.wMaxPacketSize = 0x400;
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Super, &interface_descriptor, USB_DT_INTERFACE_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Super, &endpoint_descriptor_in, USB_DT_ENDPOINT_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Super, &endpoint_companion, USB_DT_SS_ENDPOINT_COMPANION_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Super, &endpoint_descriptor_out, USB_DT_ENDPOINT_SIZE);
    if (R_SUCCEEDED(rc)) rc = append(UsbDeviceSpeed_Super, &endpoint_companion, USB_DT_SS_ENDPOINT_COMPANION_SIZE);

    if (R_SUCCEEDED(rc))
        rc = usbDsInterface_RegisterEndpoint(g_interface, &g_epIn, endpoint_descriptor_in.bEndpointAddress);
    if (R_SUCCEEDED(rc))
        rc = usbDsInterface_RegisterEndpoint(g_interface, &g_epOut, endpoint_descriptor_out.bEndpointAddress);
    if (R_SUCCEEDED(rc)) rc = usbDsInterface_EnableInterface(g_interface);
    return rc;
}

Result initInterface1x() {
    struct usb_interface_descriptor interface_descriptor = {
        .bLength = USB_DT_INTERFACE_SIZE,
        .bDescriptorType = USB_DT_INTERFACE,
        .bInterfaceNumber = 0,
        .bInterfaceClass = USB_CLASS_VENDOR_SPEC,
        .bInterfaceSubClass = USB_CLASS_VENDOR_SPEC,
        .bInterfaceProtocol = USB_CLASS_VENDOR_SPEC,
    };
    struct usb_endpoint_descriptor endpoint_descriptor_in = {
        .bLength = USB_DT_ENDPOINT_SIZE,
        .bDescriptorType = USB_DT_ENDPOINT,
        .bEndpointAddress = USB_ENDPOINT_IN,
        .bmAttributes = USB_TRANSFER_TYPE_BULK,
        .wMaxPacketSize = 0x200,
    };
    struct usb_endpoint_descriptor endpoint_descriptor_out = {
        .bLength = USB_DT_ENDPOINT_SIZE,
        .bDescriptorType = USB_DT_ENDPOINT,
        .bEndpointAddress = USB_ENDPOINT_OUT,
        .bmAttributes = USB_TRANSFER_TYPE_BULK,
        .wMaxPacketSize = 0x200,
    };
    Result rc = usbDsGetDsInterface(&g_interface, &interface_descriptor, "usb");
    if (R_FAILED(rc)) return rc;
    rc = usbDsInterface_GetDsEndpoint(g_interface, &g_epIn, &endpoint_descriptor_in);
    if (R_FAILED(rc)) return rc;
    rc = usbDsInterface_GetDsEndpoint(g_interface, &g_epOut, &endpoint_descriptor_out);
    if (R_FAILED(rc)) return rc;
    return usbDsInterface_EnableInterface(g_interface);
}

Result waitTransfer(UsbDsEndpoint* ep, void* buffer, size_t size, u32* transferred, uint64_t timeoutNs) {
    u32 urbId = 0;
    Result rc = usbDsEndpoint_PostBufferAsync(ep, buffer, size, &urbId);
    if (R_FAILED(rc)) return rc;
    rc = eventWait(&ep->CompletionEvent, timeoutNs);
    if (R_FAILED(rc)) {
        usbDsEndpoint_Cancel(ep);
        eventWait(&ep->CompletionEvent, UINT64_MAX);
        eventClear(&ep->CompletionEvent);
        return rc;
    }
    eventClear(&ep->CompletionEvent);
    UsbDsReportData report{};
    rc = usbDsEndpoint_GetReportData(ep, &report);
    if (R_FAILED(rc)) return rc;
    return usbDsParseReportData(&report, urbId, nullptr, transferred);
}

void transferAll(UsbDsEndpoint* ep, u8* bounce, void* buf, size_t n, uint64_t timeoutNs, bool writing) {
    auto* p = static_cast<u8*>(buf);
    Result ready = usbDsWaitReady(timeoutNs);
    if (R_FAILED(ready)) fail("usbDsWaitReady", ready);
    while (n) {
        u8* xfer = p;
        size_t chunk = n;
        if ((reinterpret_cast<uintptr_t>(p) & 0xfff) != 0) {
            xfer = bounce;
            chunk = kBounce - (reinterpret_cast<uintptr_t>(p) & 0xfff);
            if (chunk > n) chunk = n;
            if (writing) std::memcpy(bounce, p, chunk);
        }
        u32 got = 0;
        Result rc = waitTransfer(ep, xfer, chunk, &got, timeoutNs);
        if (R_FAILED(rc)) fail("USB transfer", rc);
        if (!writing && xfer == bounce) std::memcpy(p, bounce, got);
        if (got == 0) throw std::runtime_error("USB transfer returned 0 bytes");
        p += got;
        n -= got;
        if (got < chunk) throw std::runtime_error("USB short transfer");
    }
}

#endif

} // namespace

bool usbDsAvailable() {
#ifdef __SWITCH__
    return true;
#else
    return false;
#endif
}

void usbDsStart() {
#ifdef __SWITCH__
    std::lock_guard<std::mutex> lock(g_mu);
    if (g_started) return;
    Result rc = usbDsInitialize();
    if (R_FAILED(rc)) fail("usbDsInitialize", rc);
    if (hosversionAtLeast(5, 0, 0)) {
        u8 iManufacturer = 0, iProduct = 0, iSerialNumber = 0;
        static const u16 langs[1] = {0x0409};
        rc = usbDsAddUsbLanguageStringDescriptor(nullptr, langs, 1);
        if (R_SUCCEEDED(rc)) rc = usbDsAddUsbStringDescriptor(&iManufacturer, "Nintendo");
        if (R_SUCCEEDED(rc)) rc = usbDsAddUsbStringDescriptor(&iProduct, "Nintendo Switch");
        if (R_SUCCEEDED(rc)) rc = usbDsAddUsbStringDescriptor(&iSerialNumber, "SerialNumber");
        struct usb_device_descriptor device_descriptor = {
            .bLength = USB_DT_DEVICE_SIZE,
            .bDescriptorType = USB_DT_DEVICE,
            .bcdUSB = 0x0110,
            .bDeviceClass = 0x00,
            .bDeviceSubClass = 0x00,
            .bDeviceProtocol = 0x00,
            .bMaxPacketSize0 = 0x40,
            .idVendor = kVid,
            .idProduct = kPid,
            .bcdDevice = 0x0100,
            .iManufacturer = iManufacturer,
            .iProduct = iProduct,
            .iSerialNumber = iSerialNumber,
            .bNumConfigurations = 0x01,
        };
        if (R_SUCCEEDED(rc)) rc = usbDsSetUsbDeviceDescriptor(UsbDeviceSpeed_Full, &device_descriptor);
        device_descriptor.bcdUSB = 0x0200;
        if (R_SUCCEEDED(rc)) rc = usbDsSetUsbDeviceDescriptor(UsbDeviceSpeed_High, &device_descriptor);
        device_descriptor.bcdUSB = 0x0300;
        device_descriptor.bMaxPacketSize0 = 0x09;
        if (R_SUCCEEDED(rc)) rc = usbDsSetUsbDeviceDescriptor(UsbDeviceSpeed_Super, &device_descriptor);
        u8 bos[0x16] = {0x05, USB_DT_BOS, 0x16, 0x00, 0x02, 0x07, USB_DT_DEVICE_CAPABILITY, 0x02, 0x02, 0x00, 0x00,
            0x00, 0x0A, USB_DT_DEVICE_CAPABILITY, 0x03, 0x00, 0x0E, 0x00, 0x03, 0x00, 0x00, 0x00};
        if (R_SUCCEEDED(rc)) rc = usbDsSetBinaryObjectStore(bos, sizeof(bos));
    }
    if (R_SUCCEEDED(rc)) {
        g_bounceIn = static_cast<u8*>(memalign(0x1000, kBounce));
        g_bounceOut = static_cast<u8*>(memalign(0x1000, kBounce));
        if (!g_bounceIn || !g_bounceOut) rc = MAKERESULT(Module_Libnx, LibnxError_OutOfMemory);
    }
    if (R_SUCCEEDED(rc)) rc = hosversionAtLeast(5, 0, 0) ? initInterface5x() : initInterface1x();
    if (R_SUCCEEDED(rc) && hosversionAtLeast(5, 0, 0)) rc = usbDsEnable();
    if (R_FAILED(rc)) {
        usbDsExit();
        free(g_bounceIn);
        free(g_bounceOut);
        g_bounceIn = g_bounceOut = nullptr;
        g_interface = nullptr;
        g_epIn = g_epOut = nullptr;
        fail("usbDsStart", rc);
    }
    g_started = true;
#else
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

void usbDsStop() {
#ifdef __SWITCH__
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_started) return;
    usbDsExit();
    free(g_bounceIn);
    free(g_bounceOut);
    g_bounceIn = g_bounceOut = nullptr;
    g_interface = nullptr;
    g_epIn = g_epOut = nullptr;
    g_started = false;
#endif
}

void usbDsReadAll(void* dst, size_t n, uint64_t timeoutNs) {
#ifdef __SWITCH__
    if (!g_started || !g_epOut) throw std::runtime_error("USB not started");
    transferAll(g_epOut, g_bounceOut, dst, n, timeoutNs, false);
#else
    (void)dst;
    (void)n;
    (void)timeoutNs;
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

void usbDsWriteAll(const void* src, size_t n, uint64_t timeoutNs) {
#ifdef __SWITCH__
    if (!g_started || !g_epIn) throw std::runtime_error("USB not started");
    transferAll(g_epIn, g_bounceIn, const_cast<void*>(src), n, timeoutNs, true);
#else
    (void)src;
    (void)n;
    (void)timeoutNs;
    throw std::runtime_error("USB transport requires a Switch");
#endif
}

void usbDsCancel() {
#ifdef __SWITCH__
    if (g_epIn) usbDsEndpoint_Cancel(g_epIn);
    if (g_epOut) usbDsEndpoint_Cancel(g_epOut);
#endif
}

} // namespace nslib
