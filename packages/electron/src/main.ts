import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type NslibServer, SESSION_COOKIE } from "@nslib/server";
import { DEFAULT_SERVER_PORT, DISCOVERY_PORT } from "@nslib/shared";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  session,
  Tray,
} from "electron";
import { trayIconPng } from "./tray-icon";

const here = dirname(fileURLToPath(import.meta.url));
/** How many ports after the preferred one to try when it's taken. */
const PORT_ATTEMPTS = 10;
/** Tray menus are rebuilt at most this often, since rebuilding closes an open menu on some OSes. */
const TRAY_MIN_REFRESH_MS = 3000;
/** Picks up devices going offline, which has no event of its own. */
const TRAY_POLL_MS = 15_000;

interface DesktopSettings {
  allowLan: boolean;
  /** The port the server last listened on, reused so paired Switches keep their address. */
  port: number;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "desktop.json");
}

function loadDesktopSettings(): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<DesktopSettings>;
    const port = Number(raw.port);
    return {
      allowLan: Boolean(raw.allowLan),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SERVER_PORT,
    };
  } catch {
    return { allowLan: false, port: DEFAULT_SERVER_PORT };
  }
}

function saveDesktopSettings(settings: DesktopSettings): void {
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

function webDir(): string | null {
  const candidates = [
    join(here, "../../web/dist"),
    join(here, "../../../packages/web/dist"),
    process.env.NSLIB_WEB_DIR,
  ];
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

/** A file in the data directory if it exists, like the server's own defaults. */
function dataFile(...parts: string[]): string | null {
  const path = join(app.getPath("userData"), ...parts);
  return existsSync(path) ? path : null;
}

let server: NslibServer | undefined;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let desktop = loadDesktopSettings();
let port = desktop.port;
let quitting = false;
let closed = false;

function serverUrl(): string {
  return `http://127.0.0.1:${port}`;
}

/** Listens on the saved port, or the next free one. Returns the port in use. */
async function listen(instance: NslibServer, host: string, preferred: number): Promise<number> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const candidate = preferred + attempt;
    try {
      await instance.app.listen({ host, port: candidate });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`Ports ${preferred}–${preferred + PORT_ATTEMPTS - 1} are all in use`);
}

async function boot(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => void showWindow());

  const host = desktop.allowLan ? "0.0.0.0" : "127.0.0.1";
  server = await createServer({
    dataDir: app.getPath("userData"),
    host,
    port: desktop.port,
    webDir: webDir(),
    forcePolling: false,
    pollIntervalMs: 2000,
    stabilityThresholdMs: 5000,
    logLevel: "info",
    trustProxy: false,
    seed: false,
    seedLibraryDir: null,
    seedKeysPath: null,
    // No setup token: the desktop app binds loopback unless the user opts into LAN, and whoever is
    // at this machine is the owner. The headless server (loadConfig) generates one instead.
    setupToken: null,
    serverName: "NSLibrary",
    discoveryPort: desktop.allowLan ? DISCOVERY_PORT : null,
    usb: true,
    libraryScanDir: null,
    tlsKey: null,
    tlsCert: null,
    nroPath: dataFile("update", "nslibrary.nro"),
    forwarderMainPath: dataFile("forwarder", "main"),
  });

  try {
    port = await listen(server, host, desktop.port);
  } catch (err) {
    dialog.showErrorBox(
      "NSLibrary couldn't start",
      `${err instanceof Error ? err.message : String(err)}. Close the program using them and try again.`,
    );
    await server.close();
    app.exit(1);
    return;
  }
  if (port !== desktop.port) {
    const previous = desktop.port;
    desktop = { ...desktop, port };
    saveDesktopSettings(desktop);
    if (desktop.allowLan) {
      void dialog.showMessageBox({
        type: "info",
        message: `NSLibrary is now on port ${port}`,
        detail: `Port ${previous} was in use by another program. Switches connected over the network need the new address; USB isn't affected.`,
      });
    }
  }
  await server.start();

  if (!server.auth.isSetupRequired()) {
    const { token } = server.auth.createSession("electron");
    await session.defaultSession.cookies.set({
      url: serverUrl(),
      name: SESSION_COOKIE,
      value: token,
      path: "/",
      httpOnly: true,
    });
  }

  ipcMain.handle("nslib:pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Library folder",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  await showWindow();
  buildTray(server);
}

async function showWindow(): Promise<void> {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  await window.loadURL(serverUrl());
}

function trayImage(): Electron.NativeImage {
  const template = process.platform === "darwin";
  const image = nativeImage.createFromBuffer(trayIconPng(16, template), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: trayIconPng(32, template) });
  if (template) image.setTemplateImage(true);
  return image;
}

async function setAllowLan(allowLan: boolean): Promise<void> {
  desktop = { ...desktop, allowLan };
  saveDesktopSettings(desktop);
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: allowLan ? "Let Switches on your network connect?" : "Only allow this computer?",
    detail: "NSLibrary needs to restart to apply this. Installs in progress will be interrupted.",
  });
  if (response === 0) {
    app.relaunch();
    app.quit();
  }
}

function buildTray(instance: NslibServer): void {
  tray = new Tray(trayImage());
  tray.setToolTip("NSLibrary");

  const template = (): MenuItemConstructorOptions[] => {
    const devices = instance.devices.listDevices();
    const running = instance.devices
      .listJobs(undefined, 0)
      .filter((j) => j.status === "claimed" || j.status === "running");
    const deviceItems: MenuItemConstructorOptions[] = devices.length
      ? devices.map((d) => ({
          label: `${d.online ? "●" : "○"} ${d.name}${d.transport ? ` (${d.transport})` : ""}`,
          enabled: false,
        }))
      : [{ label: "No Switches paired", enabled: false }];
    const jobItems: MenuItemConstructorOptions[] = running.length
      ? running.map((j) => {
          // Whole tens, so progress doesn't rebuild an open menu every few seconds.
          const pct = j.size > 0 ? Math.floor((j.bytesDone / j.size) * 10) * 10 : 0;
          return { label: `${j.name} ${pct}%`, enabled: false };
        })
      : [{ label: "No active installs", enabled: false }];
    return [
      { label: "Open NSLibrary", click: () => void showWindow() },
      { type: "separator" },
      { label: "Devices", enabled: false },
      ...deviceItems,
      { type: "separator" },
      ...jobItems,
      { type: "separator" },
      {
        label: "Pause scanning",
        type: "checkbox",
        checked: instance.scanner.paused,
        click: (item) => void instance.scanner.setPaused(item.checked).then(refresh),
      },
      {
        label: desktop.allowLan ? "Allow LAN devices" : "Allow LAN devices (restart to apply)",
        type: "checkbox",
        checked: desktop.allowLan,
        click: (item) => void setAllowLan(item.checked).then(refresh),
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ];
  };

  let shown = "";
  let lastBuilt = 0;
  let pending: NodeJS.Timeout | null = null;
  const refresh = () => {
    if (pending || !tray) return;
    const wait = Math.max(0, lastBuilt + TRAY_MIN_REFRESH_MS - Date.now());
    pending = setTimeout(() => {
      pending = null;
      if (!tray || tray.isDestroyed()) return;
      const items = template();
      // Rebuilding closes an open menu on some platforms, so only do it when something changed.
      const signature = JSON.stringify(items.map((i) => [i.label, i.checked, i.type]));
      if (signature === shown) return;
      shown = signature;
      lastBuilt = Date.now();
      tray.setContextMenu(Menu.buildFromTemplate(items));
    }, wait);
  };

  refresh();
  const unsubscribe = instance.events.subscribe((event) => {
    if (event.type.startsWith("device.") || event.type === "job.updated") refresh();
  });
  const poll = setInterval(refresh, TRAY_POLL_MS);
  poll.unref();
  app.once("will-quit", () => {
    unsubscribe();
    clearInterval(poll);
    if (pending) clearTimeout(pending);
  });
  tray.on("click", () => void showWindow());
}

app.whenReady().then(() => void boot());
app.on("before-quit", () => {
  quitting = true;
});
// Close the server (watchers, USB, database) before the process exits, however quit was chosen.
app.on("will-quit", (event) => {
  if (closed || !server) return;
  event.preventDefault();
  closed = true;
  void server
    .close()
    .catch(() => undefined)
    .finally(() => app.quit());
});
