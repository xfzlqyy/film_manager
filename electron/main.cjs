const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { access, copyFile, mkdir, readFile, writeFile } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const path = require("node:path");

let mainWindow = null;
let currentDataPath = "";
let settingsCache = null;

function toFilePath(value) {
  return path.resolve(value);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean)));
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathWritable(filePath) {
  try {
    if (await fileExists(filePath)) {
      await access(filePath, fsConstants.W_OK);
      return true;
    }
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getSettingsPath() {
  return toFilePath(path.join(app.getPath("userData"), "settings.json"));
}

async function readSettings() {
  if (settingsCache) {
    return settingsCache;
  }
  try {
    const content = await readFile(getSettingsPath(), "utf8");
    settingsCache = JSON.parse(content);
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

async function writeSettings(nextSettings) {
  settingsCache = nextSettings;
  const settingsPath = getSettingsPath();
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(nextSettings, null, 2), "utf8");
}

async function getSavedDataPath() {
  const settings = await readSettings();
  const saved = settings.dataPath;
  if (typeof saved !== "string" || saved.trim() === "") {
    return "";
  }
  return toFilePath(saved);
}

async function persistCurrentPath(nextPath) {
  const settings = await readSettings();
  await writeSettings({
    ...settings,
    dataPath: nextPath
  });
}

function getUserDataPath() {
  return toFilePath(path.join(app.getPath("userData"), "data.xls"));
}

function getProjectDataPath() {
  return toFilePath(path.join(process.cwd(), "data.xls"));
}

function getProjectPublicDataPath() {
  return toFilePath(path.join(process.cwd(), "public", "data.xls"));
}

function getExecutableDataPath() {
  return toFilePath(path.join(path.dirname(process.execPath), "data.xls"));
}

function getResourceDataPath() {
  return toFilePath(path.join(process.resourcesPath, "data.xls"));
}

function getAppPathDataPath() {
  return toFilePath(path.join(app.getAppPath(), "data.xls"));
}

async function resolvePreferredDataPath() {
  if (!app.isPackaged) {
    return getProjectDataPath();
  }

  const executableDataPath = getExecutableDataPath();
  if (await pathWritable(executableDataPath)) {
    return executableDataPath;
  }

  return getUserDataPath();
}

async function resolveSeedCandidates(preferredPath) {
  const savedPath = await getSavedDataPath();
  const candidates = uniquePaths([
    savedPath,
    preferredPath,
    getProjectDataPath(),
    getProjectPublicDataPath(),
    getExecutableDataPath(),
    getResourceDataPath(),
    getAppPathDataPath(),
    getUserDataPath()
  ]);

  const existing = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function ensureWritableDataFile() {
  if (currentDataPath && (await fileExists(currentDataPath))) {
    return currentDataPath;
  }

  const preferredPath = await resolvePreferredDataPath();
  if (await fileExists(preferredPath)) {
    currentDataPath = preferredPath;
    await persistCurrentPath(currentDataPath);
    return currentDataPath;
  }

  const savedPath = await getSavedDataPath();
  if (savedPath && (await fileExists(savedPath))) {
    currentDataPath = savedPath;
    return currentDataPath;
  }

  const seedCandidates = await resolveSeedCandidates(preferredPath);
  const seedPath = seedCandidates.find((item) => item !== preferredPath);
  if (seedPath) {
    await mkdir(path.dirname(preferredPath), { recursive: true });
    await copyFile(seedPath, preferredPath);
    currentDataPath = preferredPath;
    await persistCurrentPath(currentDataPath);
    return currentDataPath;
  }

  throw new Error("Cannot find any data.xls source to initialize.");
}

async function loadDataFile(dataPath) {
  const content = await readFile(dataPath);
  return {
    ok: true,
    dataBase64: content.toString("base64"),
    path: dataPath
  };
}

async function writeDataFile(contentBuffer) {
  let targetPath = await ensureWritableDataFile();

  try {
    await writeFile(targetPath, contentBuffer);
  } catch (error) {
    const fallbackPath = getUserDataPath();
    if (targetPath !== fallbackPath) {
      await mkdir(path.dirname(fallbackPath), { recursive: true });
      await writeFile(fallbackPath, contentBuffer);
      currentDataPath = fallbackPath;
      await persistCurrentPath(currentDataPath);
      return {
        ok: true,
        path: fallbackPath,
        bytes: contentBuffer.length,
        warning: `Cannot write ${targetPath}, fallback to ${fallbackPath}`
      };
    }
    throw error;
  }

  currentDataPath = targetPath;
  await persistCurrentPath(currentDataPath);

  if (!app.isPackaged) {
    try {
      const publicDataPath = getProjectPublicDataPath();
      await mkdir(path.dirname(publicDataPath), { recursive: true });
      await writeFile(publicDataPath, contentBuffer);
    } catch (error) {
      console.warn("[electron] failed to mirror public/data.xls", error);
    }
  }

  return {
    ok: true,
    path: targetPath,
    bytes: contentBuffer.length
  };
}

async function loadDevUrlWithRetry(window, url, retries = 30, intervalMs = 400) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (window.isDestroyed()) {
      throw new Error("Window was destroyed before renderer loaded.");
    }
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError ?? new Error(`Cannot load renderer URL: ${url}`);
}

async function loadErrorPage(window, errorMessage) {
  const html = `
    <html>
      <body style="font-family:Arial,sans-serif;padding:24px;line-height:1.5">
        <h2>Film Manager failed to start</h2>
        <p>Cannot load renderer.</p>
        <pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px">${String(errorMessage || "")}</pre>
        <p>If this is dev mode, confirm Vite is running on <code>http://127.0.0.1:5173</code>.</p>
      </body>
    </html>
  `;
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      await loadDevUrlWithRetry(mainWindow, devServerUrl);
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } catch (error) {
      console.error("[electron] failed to load dev server", error);
      await loadErrorPage(mainWindow, error instanceof Error ? error.message : String(error));
    }
  } else {
    try {
      await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    } catch (error) {
      console.error("[electron] failed to load packaged renderer", error);
      await loadErrorPage(mainWindow, error instanceof Error ? error.message : String(error));
    }
  }
}

function registerIpcHandlers() {
  ipcMain.handle("film:load-data", async () => {
    try {
      const dataPath = await ensureWritableDataFile();
      return await loadDataFile(dataPath);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read data.xls"
      };
    }
  });

  ipcMain.handle("film:save-data", async (_event, dataBase64) => {
    try {
      if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
        return {
          ok: false,
          error: "Save payload is empty."
        };
      }

      const content = Buffer.from(dataBase64, "base64");
      return await writeDataFile(content);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to write data.xls"
      };
    }
  });

  ipcMain.handle("film:pick-data-file", async () => {
    try {
      const selected = await dialog.showOpenDialog({
        title: "Select data.xls",
        properties: ["openFile"],
        filters: [{ name: "Excel 97-2003", extensions: ["xls"] }]
      });

      if (selected.canceled || selected.filePaths.length === 0) {
        return {
          ok: false,
          canceled: true
        };
      }

      const nextPath = toFilePath(selected.filePaths[0]);
      currentDataPath = nextPath;
      await persistCurrentPath(currentDataPath);
      return await loadDataFile(nextPath);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to open selected file."
      };
    }
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[electron] unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[electron] uncaughtException", error);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
