import {
    app,
    BrowserWindow,
    shell,
    ipcMain,
    dialog,
    protocol,
    net,
} from "electron";
import { join } from "path";
import { pathToFileURL } from "url";
import { is } from "@electron-toolkit/utils";
import {
    initDb,
    closeDb,
    getAllFiles,
    getFilesByFolder,
    getTagsForFile,
    addTag,
    removeTag,
} from "./db";
import { scanFolder, getSubfolders, getThumbnailPath } from "./scanner";
import { readFileSync, writeFileSync } from "fs";

import { existsSync } from "fs";

let rootPath: string | null = null;

function getConfigPath(): string {
    return join(app.getPath("userData"), "config.json");
}

function loadSavedRootPath(): string | null {
    try {
        const raw = readFileSync(getConfigPath(), "utf-8");
        const config = JSON.parse(raw);
        return config.rootPath ?? null;
    } catch {
        return null;
    }
}

function saveRootPath(path: string): void {
    try {
        writeFileSync(
            getConfigPath(),
            JSON.stringify({ rootPath: path }),
            "utf-8",
        );
    } catch (err) {
        console.error("Failed to save config:", err);
    }
}

function registerIpcHandlers(): void {
    // ── Utility ──────────────────────────────────────────────────────────────
    ipcMain.handle("ping", () => "pong");

    // ── Library setup ────────────────────────────────────────────────────────

    ipcMain.handle("select-root-folder", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"],
            title: "Choose your media library folder",
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    ipcMain.handle("open-library", async (_event, folderPath: string) => {
        rootPath = folderPath;
        saveRootPath(folderPath);
        initDb(folderPath);
        const result = await scanFolder(folderPath);
        return result;
    });

    ipcMain.handle("get-root-path", () => {
        if (!rootPath) {
            rootPath = loadSavedRootPath();
        }
        return rootPath;
    });

    // ── Folders & files ──────────────────────────────────────────────────────

    ipcMain.handle("get-subfolders", () => {
        if (!rootPath) return [];
        return getSubfolders(rootPath);
    });

    ipcMain.handle("get-all-files", () => {
        return getAllFiles();
    });

    ipcMain.handle("get-files-in-folder", (_event, folderRelPath: string) => {
        return getFilesByFolder(folderRelPath);
    });

    ipcMain.handle("get-thumbnail-path", (_event, hash: string) => {
        if (!rootPath) return null;
        const thumbPath = getThumbnailPath(rootPath, hash);
        return existsSync(thumbPath) ? thumbPath : null;
    });

    // ── Tags ─────────────────────────────────────────────────────────────────

    ipcMain.handle("get-tags", (_event, fileId: number) => {
        return getTagsForFile(fileId);
    });

    ipcMain.handle("add-tag", (_event, fileId: number, tag: string) => {
        addTag(fileId, tag);
        return getTagsForFile(fileId);
    });

    ipcMain.handle("remove-tag", (_event, fileId: number, tag: string) => {
        removeTag(fileId, tag);
        return getTagsForFile(fileId);
    });
}

function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        show: false,
        titleBarStyle: "hiddenInset",
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            sandbox: false,
        },
    });

    mainWindow.on("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url);
        return { action: "deny" };
    });

    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
        mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    } else {
        mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    }
}

app.whenReady().then(() => {
    protocol.handle('media', async (request) => {
  const url = request.url.replace('media://local', '')
  const filePath = decodeURIComponent(url)
  
  try {
    const { createReadStream, statSync } = require('fs')
    const stat = statSync(filePath)
    const fileSize = stat.size
    const rangeHeader = request.headers.get('range')

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      const stream = createReadStream(filePath, { start, end })
      return new Response(stream as any, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
        }
      })
    } else {
      const stream = createReadStream(filePath)
      return new Response(stream as any, {
        status: 200,
        headers: {
          'Content-Length': String(fileSize),
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        }
      })
    }
  } catch (err) {
    console.error('protocol error:', err)
    return new Response('Not found', { status: 404 })
  }
})

    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    closeDb();
    if (process.platform !== "darwin") app.quit();
});
