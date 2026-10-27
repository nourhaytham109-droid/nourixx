const { app, BrowserWindow, dialog, shell } = require("electron");
const { createServer } = require("node:net");
const { appendFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

let mainWindow;
let serverUrl;
let startupLogPath;
let shutdownRequested = false;

async function writeStartupLog(message, error) {
  const detail = error?.stack || error?.message || String(error || "");
  const entry = `[${new Date().toISOString()}] ${message}${detail ? `\n${detail}` : ""}\n`;
  console.error(message, error || "");
  if (!startupLogPath) return;
  try {
    await mkdir(path.dirname(startupLogPath), { recursive: true });
    await appendFile(startupLogPath, entry, "utf8");
  } catch (logError) {
    console.error("تعذر حفظ سجل بدء التشغيل:", logError);
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/setup/status`);
      if (response.ok) return;
      lastError = new Error(`تعذر تشغيل الخادم المحلي (HTTP ${response.status}).`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`انتهت مهلة تشغيل الخادم المحلي: ${lastError?.message || "لا توجد استجابة."}`);
}

function openExternal(url) {
  try {
    const parsedUrl = new URL(url);
    if (["https:", "mailto:", "tel:"].includes(parsedUrl.protocol)) {
      void shell.openExternal(parsedUrl.href);
    }
  } catch (error) {
    console.error("تعذر فتح الرابط الخارجي:", error);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f9fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${serverUrl}/`)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(`${serverUrl}/`);
}

async function startApplication() {
  try {
    app.setAppUserModelId("com.nourix.pos");
    process.env.NOURIX_DATA_DIR = path.join(app.getPath("userData"), "data");
    startupLogPath = path.join(app.getPath("userData"), "logs", "startup.log");
    process.env.COOKIE_SECURE = "false";
    process.env.TRUST_PROXY = "false";
    process.env.PORT = String(await findAvailablePort());
    serverUrl = `http://127.0.0.1:${process.env.PORT}`;
    await writeStartupLog(`بدء تشغيل الخادم المحلي على المنفذ ${process.env.PORT}.`);
    const { start } = require("./server.js");
    await start();
    await waitForServer(serverUrl);
    await writeStartupLog("تم تشغيل الخادم المحلي بنجاح.");
    createMainWindow();
  } catch (error) {
    await writeStartupLog("تعذر تشغيل Nourix POS:", error);
    await dialog.showMessageBox({
      type: "error",
      title: "تعذر تشغيل Nourix POS",
      message: "لم يتمكن التطبيق من بدء الخادم المحلي.",
      detail: `${error.message}${startupLogPath ? `\n\nسجل التفاصيل:\n${startupLogPath}` : ""}`,
    });
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startApplication);
  app.on("activate", () => {
    if (!mainWindow && serverUrl) createMainWindow();
  });
  app.on("before-quit", (event) => {
    if (!serverUrl || shutdownRequested) return;
    event.preventDefault();
    shutdownRequested = true;
    process.kill(process.pid, "SIGTERM");
  });
  app.on("window-all-closed", () => app.quit());
}
