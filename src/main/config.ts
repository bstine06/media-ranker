import { app } from "electron"
import { join } from "path"
import { readFileSync, writeFileSync } from "fs"

export function getConfigPath(): string {
    return join(app.getPath("userData"), "config.json")
}

export function loadSavedRootPath(): string | null {
    try {
        const raw = readFileSync(getConfigPath(), "utf-8")
        const config = JSON.parse(raw)
        return config.rootPath ?? null
    } catch {
        return null
    }
}

export function saveRootPath(path: string | null): void {
    try {
        writeFileSync(
            getConfigPath(),
            JSON.stringify({ rootPath: path }),
            "utf-8",
        )
    } catch (err) {
        console.error("Failed to save config:", err)
    }
}

export const INTERNAL_NAMES = new Set([
    "_thumbnails",
    "_media_index.db",
    "_media_index.db-shm",
    "_media_index.db-wal",
]);