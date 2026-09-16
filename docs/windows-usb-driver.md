# Windows USB driver (Zadig)

NSLibrary talks to a Switch over USB using WinUSB. Windows will not bind that driver on its own.

1. Plug the Switch into the PC with NSLibrary running on the console (USB cable option on the Connect screen).
2. Download [Zadig](https://zadig.akeo.ie/).
3. Options → **List All Devices**.
4. Select the device with USB ID `057E:3000`.
5. Replace the driver with **WinUSB** (libusbK also works).
6. Retry the USB session. If Electron logged `LIBUSB_ERROR_NOT_SUPPORTED`, this is the missing step.

macOS needs no driver. On Linux, install `packages/electron/udev/99-nslibrary.rules` as `/etc/udev/rules.d/99-nslibrary.rules` and replug.
