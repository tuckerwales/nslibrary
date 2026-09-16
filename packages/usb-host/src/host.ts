import { USB_PRODUCT_ID, USB_VENDOR_ID } from "@nslib/shared";
import type { ByteChannel } from "./duplex";
import { UsbLink, type UsbLinkOptions } from "./session";

export interface UsbHostHandle {
  stop(): Promise<void>;
}

interface TransferEndpoint {
  direction: string;
  transfer(sizeOrData: number | Uint8Array, timeout?: number): Promise<Uint8Array | undefined>;
}

interface UsbDeviceLike {
  open(): void;
  close(): void;
  interfaces: Array<{
    claimed: boolean;
    claim(): void;
    endpoints: TransferEndpoint[];
  }>;
}

/**
 * Attach to a Nintendo Switch in usbComms gadget mode (VID 057E / PID 3000).
 * Dynamic-imports `usb` so tests and machines without libusb still load the rest of the package.
 */
export async function startUsbHost(options: UsbLinkOptions): Promise<UsbHostHandle> {
  let usb: typeof import("usb");
  try {
    usb = await import("usb");
  } catch (err) {
    options.log?.("USB support is unavailable (the usb native module is not loaded)", err);
    return { async stop() {} };
  }

  const abort = new AbortController();
  const links = new Set<UsbLink>();
  const onAttach = (device: UsbDeviceLike) => {
    const desc = device as unknown as {
      deviceDescriptor?: { idVendor: number; idProduct: number };
    };
    if (desc.deviceDescriptor?.idVendor !== USB_VENDOR_ID) return;
    if (desc.deviceDescriptor?.idProduct !== USB_PRODUCT_ID) return;
    try {
      const channel = openDeviceChannel(device);
      const link = new UsbLink(channel, options);
      links.add(link);
      void link.run(abort.signal).finally(() => {
        links.delete(link);
        const { bytesIn, bytesOut, elapsedMs } = link.stats();
        const sec = Math.max(0.001, elapsedMs / 1000);
        options.log?.(
          `USB session ended: in ${(bytesIn / 1e6 / sec).toFixed(2)} MB/s, out ${(bytesOut / 1e6 / sec).toFixed(2)} MB/s`,
        );
      });
    } catch (err) {
      const code = (err as { errno?: number }).errno;
      // libusb LIBUSB_ERROR_NOT_SUPPORTED = -12
      if (code === -12 || String(err).includes("NOT_SUPPORTED")) {
        options.log?.(
          "This Switch needs a WinUSB driver. Install it with Zadig (see docs/windows-usb-driver.md).",
          err,
        );
        return;
      }
      options.log?.("Failed to open USB Switch", err);
    }
  };

  usb.usb.on("attach", onAttach as (device: unknown) => void);
  for (const device of usb.getDeviceList()) onAttach(device as unknown as UsbDeviceLike);

  return {
    async stop() {
      abort.abort();
      usb.usb.off("attach", onAttach as (device: unknown) => void);
      for (const link of links) link.stop();
      links.clear();
    },
  };
}

function openDeviceChannel(device: UsbDeviceLike): ByteChannel {
  device.open();
  const iface = device.interfaces[0];
  if (!iface) throw new Error("USB Switch has no interface");
  if (!iface.claimed) iface.claim();
  const inn = iface.endpoints.find((e) => e.direction === "in");
  const out = iface.endpoints.find((e) => e.direction === "out");
  if (!inn || !out) throw new Error("USB Switch is missing bulk IN/OUT endpoints");
  (inn as TransferEndpoint & { timeout?: number }).timeout = 15_000;
  (out as TransferEndpoint & { timeout?: number }).timeout = 15_000;

  let closed = false;
  const leftover: Uint8Array[] = [];

  const pull = (dst: Uint8Array): number => {
    let filled = 0;
    while (filled < dst.byteLength && leftover.length > 0) {
      const chunk = leftover[0];
      if (!chunk) break;
      const take = Math.min(dst.byteLength - filled, chunk.byteLength);
      dst.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) leftover.shift();
      else leftover[0] = chunk.subarray(take);
    }
    return filled;
  };

  return {
    get closed() {
      return closed;
    },
    async readExact(n: number, signal?: AbortSignal): Promise<Uint8Array> {
      const outBuf = new Uint8Array(n);
      let filled = pull(outBuf);
      while (filled < n) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (closed) throw new Error("USB channel closed");
        const chunk = (await inn.transfer(Math.max(n - filled, 512))) as Uint8Array | undefined;
        if (!chunk || chunk.byteLength === 0) continue;
        leftover.push(chunk);
        filled += pull(outBuf.subarray(filled));
      }
      return outBuf;
    },
    async write(data: Uint8Array): Promise<void> {
      if (closed) throw new Error("USB channel closed");
      if (data.byteLength === 0) {
        await out.transfer(new Uint8Array(0));
        return;
      }
      await out.transfer(Buffer.from(data));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        device.close();
      } catch {
        /* already gone */
      }
    },
  };
}
