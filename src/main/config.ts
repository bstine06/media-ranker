import { app } from "electron"
import { join } from "path"
import { readFileSync, writeFileSync } from "fs"

// App-wide config (not per library): last opened library + user settings.
// Lives in Electron's userData dir as config.json.
interface AppConfig {
    rootPath?: string | null
    settings?: Record<string, unknown>
}

export function getConfigPath(): string {
    return join(app.getPath("userData"), "config.json")
}

function readConfig(): AppConfig {
    try {
        const parsed = JSON.parse(readFileSync(getConfigPath(), "utf-8"))
        return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
        return {}
    }
}

// Merge-write so saving one key never wipes the others.
function updateConfig(patch: Partial<AppConfig>): void {
    try {
        writeFileSync(
            getConfigPath(),
            JSON.stringify({ ...readConfig(), ...patch }, null, 2),
            "utf-8",
        )
    } catch (err) {
        console.error("Failed to save config:", err)
    }
}

export function loadSavedRootPath(): string | null {
    return readConfig().rootPath ?? null
}

export function saveRootPath(path: string | null): void {
    updateConfig({ rootPath: path })
}

export function loadSettings(): Record<string, unknown> {
    return readConfig().settings ?? {}
}

export function saveSettings(settings: Record<string, unknown>): void {
    updateConfig({ settings })
}

export const INTERNAL_NAMES = new Set([
    "_thumbnails",
    "_media_index.db",
    "_media_index.db-shm",
    "_media_index.db-wal",
]);
