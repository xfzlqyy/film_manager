const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { copyFile, mkdir, readFile, writeFile } = require("node:fs/promises");
const { access } = require("node:fs/promises");
const path = require("node:path");

let mainWindow = null;
let currentDataPath = "";

function toFilePath(value) {
  return path.resolve(value);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveSeedCandidates() {
  const appPath = app.getAppPath();
  const cwd = process.cwd();
  return [
    toFilePath(path.join(process.resourcesPath, "data.xls")),
    toFilePath(path.join(appPath, "data.xls")),
    toFilePath(path.join(cwd, "data.xls")),
    toFilePath(path.join(cwd, "public", "data.xls"))
  ];
}

async function ensureWritableDataFile() {
  if (currentDataPath) {
    return currentDataPath;
  }

  const userDataDir = app.getPath("userData");
  const targetPath = toFilePath(path.join(userDataDir, "data.xls"));
  await mkdir(path.dirname(targetPath), { recursive: true });

  if (!(await fileExists(targetPath))) {
    const candidates = resolveSeedCandidates();
    let copied = false;
    for (const sourcePath of candidates) {
      if (await fileExists(sourcePath)) {
        await copyFile(sourcePath, targetPath);
        copied = true;
        break;
      }
    }

    if (!copied) {
      throw new Error("Cannot find initial data.xls source.");
    }
  }

  currentDataPath = targetPath;
  return currentDataPath;
}

async function loadDataFile(dataPath) {
  const content = await readFile(dataPath);
  return {
    ok: true,
    dataBase64: content.toString("base64"),
    path: dataPath
  };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
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

      const dataPath = await ensureWritableDataFile();
      const content = Buffer.from(dataBase64, "base64");
      await writeFile(dataPath, content);
      return {
        ok: true,
        path: dataPath,
        bytes: content.length
      };
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
