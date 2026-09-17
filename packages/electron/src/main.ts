import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type NslibServer, SESSION_COOKIE } from "@nslib/server";
import { DEFAULT_SERVER_PORT } from "@nslib/shared";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, Tray } from "electron";

const here = dirname(fileURLToPath(import.meta.url));

interface DesktopSettings {
  allowLan: boolean;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "desktop.json");
}

function loadDesktopSettings(): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as DesktopSettings;
    return { allowLan: Boolean(raw.allowLan) };
  } catch {
    return { allowLan: false };
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

let server: NslibServer | undefined;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let desktop = loadDesktopSettings();
let quitting = false;

async function boot(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showWindow());

  const host = desktop.allowLan ? "0.0.0.0" : "127.0.0.1";
  const port = DEFAULT_SERVER_PORT;
  server = await createServer({
    dataDir: app.getPath("userData"),
    host,
    port,
    webDir: webDir(),
    forcePolling: false,
    pollIntervalMs: 2000,
    stabilityThresholdMs: 5000,
    logLevel: "info",
    trustProxy: false,
    seed: false,
    seedLibraryDir: null,
    seedKeysPath: null,
    setupToken: null,
    serverName: "NSLibrary",
    discoveryPort: desktop.allowLan ? 8466 : null,
    usb: true,
    libraryScanDir: null,
    tlsKey: null,
    tlsCert: null,
    nroPath: null,
    forwarderMainPath: null,
  });
  await server.app.listen({ host, port });
  await server.start();

  if (!server.auth.isSetupRequired()) {
    const { token } = server.auth.createSession("electron");
    await session.defaultSession.cookies.set({
      url: `http://127.0.0.1:${port}`,
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
  buildTray();
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
  await window.loadURL(`http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
}

function buildTray(): void {
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("NSLibrary");
  const refresh = () => {
    const devices = server?.devices.listDevices() ?? [];
    const jobs = server?.devices.listJobs() ?? [];
    const running = jobs.filter((j) => j.status === "claimed" || j.status === "running");
    const deviceItems = devices.length
      ? devices.map((d) => ({
          label: `${d.online ? "●" : "○"} ${d.name}${d.transport ? ` (${d.transport})` : ""}`,
          enabled: false,
        }))
      : [{ label: "No Switches paired", enabled: false }];
    const jobItems = running.length
      ? running.map((j) => {
          const pct = j.size > 0 ? Math.round((j.bytesDone / j.size) * 100) : 0;
          return { label: `${j.name} ${pct}%`, enabled: false };
        })
      : [{ label: "No active installs", enabled: false }];
    const menu = Menu.buildFromTemplate([
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
        checked: server?.scanner.paused ?? false,
        click: (item) => void server?.scanner.setPaused(item.checked),
      },
      {
        label: "Allow LAN devices",
        type: "checkbox",
        checked: desktop.allowLan,
        click: (item) => {
          desktop = { allowLan: item.checked };
          saveDesktopSettings(desktop);
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: async () => {
          quitting = true;
          await server?.close();
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(menu);
  };
  refresh();
  setInterval(refresh, 2000).unref();
  tray.on("click", () => void showWindow());
}

app.whenReady().then(() => void boot());
app.on("before-quit", () => {
  quitting = true;
});
