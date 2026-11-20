// ── App-wide undo history ───────────────────────────────────────────────────
//
// One linear history of everything that changes library data, for this
// session only (never saved). Each entry can reverse itself:
//
// Database: while an action runs, temporary triggers on the library's
// tables write, for every row it inserts, deletes or changes, the SQL that
// puts that row back (the technique from sqlite.org/undoredo.html). Undoing
// runs those statements newest first, with the triggers still on, so they
// record the SQL for redoing it. Only rows written inside an action are
// recorded: the watcher, the scanner and Sweep's screen seconds never are.
// An update records only the columns the action changed, so a later rename
// picked up by the watcher survives an undo.
//
// Disk: deletes, replaces and rotations don't send the old file to the
// Trash; it goes to a hidden holding folder in the library, so undo can put
// it straight back. A held file goes to the real Trash when its entry falls
// off the end of the history, when it's discarded as a redo, when the app
// quits, or at the next launch after a crash.
//
// If a step can't be undone (a file changed outside the app), undoing stops
// there: that entry and everything older are dropped.

import type Database from "better-sqlite3";
import { BrowserWindow, shell } from "electron";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

export const HOLDING_DIR = ".media-ranker-undo";
const MAX_ENTRIES = 200;

// Tables whose rows are library data. Not pass_run (a bookmark) or
// feed_history (recently used filters).
const TRACKED_TABLES = [
    "tag_categories",
    "tags",
    "metadata_fields",
    "folders",
    "folder_metadata",
    "folder_tags",
    "folder_noes",
    "files",
    "file_tags",
    "tag_implications",
    "tag_implied",
    "comparisons",
    "tag_checks",
    "feeds",
];

/** What the renderer needs to react to an entry being undone or redone. */
export type EntryMeta =
    | { kind: "compare"; winnerId: number; loserId: number }
    | { kind: "placement"; placingId: number; opponentId: number }
    /** Views showing the file may step back to it on undo. */
    | { kind: "pass-no"; fileId: number; tagId: number }
    | { kind: "delete"; fileIds: number[] };

/** A file or folder moved by the action. `from`/`to` are absolute. For a
 *  library file with `fileId`, its current path is read from the database
 *  when it's the one being moved (it may have been renamed since). */
type MoveOp = {
    kind: "move";
    from: string;
    to: string;
    fileId?: number;
    /** A whole collection folder: renamed (fromRel → toRel), or deleted
     *  (into the holding folder; `fileIds` are files that went with it). */
    folder?: { fromRel: string; toRel: string; mode: "rename" | "delete"; fileIds: number[] };
};
/** A file's content replaced (rotate, replace): `held` is the other version. */
type SwapOp = { kind: "swap"; fileId: number; held: string };
/** A new, empty collection folder. */
type MkdirOp = { kind: "mkdir"; path: string; relPath: string };
type DiskOp = MoveOp | SwapOp | MkdirOp;

interface Entry {
    id: number;
    label: string;
    /** SQL that reverses the entry's database changes, in the order they
     *  were made (run newest first). */
    sql: string[];
    disk: DiskOp[];
    meta?: EntryMeta;
}

/** Library access the undo module needs from index.ts. */
export interface UndoHost {
    rootPath: () => string | null;
    ignoredPaths: Set<string>;
    fileById: (id: number) => { path: string; content_hash: string; media_type: string } | undefined;
    /** Active files under a folder path. */
    filesUnder: (relPath: string) => { path: string; content_hash: string; media_type: string }[];
    /** Regenerate a thumbnail if it's missing (a restored version). */
    ensureThumbnail: (relPath: string) => Promise<void>;
}

let db: Database.Database | null = null;
let host: UndoHost | null = null;
let recording = false;
let nextId = 1;
let busy = false;
const done: Entry[] = [];
const undone: Entry[] = [];

// ── Setup ───────────────────────────────────────────────────────────────────

/** Installs the change triggers on a freshly opened library connection
 *  and clears the history (it belongs to the previous library). */
export function initUndo(database: Database.Database, h: UndoHost): void {
    db = database;
    host = h;
    clearHistory();
    database.function("undo_rec", { deterministic: false }, () => (recording ? 1 : 0));
    database.exec(`
        DROP TABLE IF EXISTS temp.undo_log;
        CREATE TEMP TABLE undo_log (seq INTEGER PRIMARY KEY, sql TEXT NOT NULL);
    `);
    for (const table of TRACKED_TABLES) {
        const cols = (database.pragma(`table_info(${table})`) as { name: string }[]).map(
            (c) => c.name,
        );
        if (cols.length === 0) continue;
        const colList = cols.join(", ");
        const oldValues = cols.map((c) => `quote(old.${c})`).join(" || ',' || ");
        const changed = cols.map((c) => `old.${c} IS NOT new.${c}`).join(" OR ");
        const setParts = cols
            .map((c) => `CASE WHEN old.${c} IS NOT new.${c} THEN ',${c}=' || quote(old.${c}) ELSE '' END`)
            .join(" || ");
        // Undoing a new tag_checks row keeps any Sweep seconds counted on
        // it since: only the answers come off, and the row goes only if
        // nothing else is left on it.
        const insertInverse =
            table === "tag_checks"
                ? `'UPDATE tag_checks SET rejected=0, passed=0 WHERE rowid=' || new.rowid || '; DELETE FROM tag_checks WHERE rowid=' || new.rowid || ' AND seconds=0'`
                : `'DELETE FROM ${table} WHERE rowid=' || new.rowid`;
        database.exec(`
            DROP TRIGGER IF EXISTS temp.undo_${table}_ins;
            DROP TRIGGER IF EXISTS temp.undo_${table}_del;
            DROP TRIGGER IF EXISTS temp.undo_${table}_upd;
            CREATE TEMP TRIGGER undo_${table}_ins AFTER INSERT ON main.${table}
            WHEN undo_rec() BEGIN
                INSERT INTO undo_log (sql) VALUES (${insertInverse});
            END;
            CREATE TEMP TRIGGER undo_${table}_del AFTER DELETE ON main.${table}
            WHEN undo_rec() BEGIN
                INSERT INTO undo_log (sql) VALUES (
                    'INSERT INTO ${table} (rowid, ${colList}) VALUES (' || old.rowid || ',' || ${oldValues} || ')'
                );
            END;
            CREATE TEMP TRIGGER undo_${table}_upd AFTER UPDATE ON main.${table}
            WHEN undo_rec() AND (${changed}) BEGIN
                INSERT INTO undo_log (sql) VALUES (
                    'UPDATE ${table} SET ' || substr(${setParts}, 2) || ' WHERE rowid=' || old.rowid
                );
            END;
        `);
    }
}

/** Absolute path of the holding folder of the open library. */
function holdingDir(): string | null {
    const root = host?.rootPath();
    return root ? path.join(root, HOLDING_DIR) : null;
}

/** Held files that are only another version of a file still in the
 *  library (a rotation's original) start with this, and are deleted for
 *  good when they leave the holding folder instead of going to the Trash.
 *  Every other held name starts with a digit, so nothing else matches. */
const DISCARD_PREFIX = "discard-";

/** A fresh path in the holding folder for a file or folder named `name`.
 *  `discard`: see DISCARD_PREFIX. */
export async function holdingPath(name: string, opts: { discard?: boolean } = {}): Promise<string> {
    const dir = holdingDir();
    if (!dir) throw new Error("No library open");
    await fs.mkdir(dir, { recursive: true });
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
    return path.join(dir, opts.discard ? DISCARD_PREFIX + unique : unique);
}

/** A held file leaving the holding folder: deleted for good if it's a
 *  discard (DISCARD_PREFIX), else sent to the Trash. */
async function releaseHeld(p: string): Promise<void> {
    if (path.basename(p).startsWith(DISCARD_PREFIX)) await fs.rm(p, { recursive: true, force: true });
    else await shell.trashItem(p);
}

// ── Recording ───────────────────────────────────────────────────────────────

/** An action in progress. Database writes go through `db()`, disk moves are
 *  added with `disk()`; `commit()` puts it in the history (if it changed
 *  anything). Actions that await between writes keep one step open. */
export class Step {
    sql: string[] = [];
    ops: DiskOp[] = [];
    meta?: EntryMeta;
    constructor(public label: string) {}

    /** Runs synchronous database writes, recording how to reverse them. */
    db<T>(fn: () => T): T {
        if (!db || recording) return fn(); // nested: the outer step records
        const database = db;
        recording = true;
        try {
            const result = database.transaction(fn)();
            const rows = database
                .prepare(`SELECT sql FROM temp.undo_log ORDER BY seq`)
                .all() as { sql: string }[];
            for (const r of rows) this.sql.push(r.sql);
            return result;
        } finally {
            recording = false;
            database.exec(`DELETE FROM temp.undo_log`);
        }
    }

    disk(op: DiskOp): void {
        this.ops.push(op);
    }

    commit(): void {
        if (this.sql.length === 0 && this.ops.length === 0) return;
        for (const e of undone.splice(0)) purge(e, false);
        done.push({ id: nextId++, label: this.label, sql: this.sql, disk: this.ops, meta: this.meta });
        while (done.length > MAX_ENTRIES) purge(done.shift()!, true);
        broadcastList();
    }
}

/** A synchronous action: records `fn` as one entry labelled `label`
 *  (a function gets the result, e.g. to name what was created; returning
 *  null records nothing). */
export function record<T>(
    label: string | ((result: T) => string | null),
    fn: () => T,
    meta?: EntryMeta,
): T {
    if (recording) return fn();
    const step = new Step("");
    const result = step.db(fn);
    const text = typeof label === "function" ? label(result) : label;
    if (text == null) return result;
    step.label = text;
    step.meta = meta;
    step.commit();
    return result;
}

export function beginStep(label: string): Step {
    return new Step(label);
}

// ── Undo / redo ─────────────────────────────────────────────────────────────

export interface HistoryItem {
    id: number;
    label: string;
    /** Undone: shown dimmed, can be redone. */
    undone: boolean;
}

export function historyList(): HistoryItem[] {
    return [
        ...done.map((e) => ({ id: e.id, label: e.label, undone: false })),
        // Then the undone ones, the next to redo first.
        ...[...undone].reverse().map((e) => ({ id: e.id, label: e.label, undone: true })),
    ];
}

export interface Applied {
    direction: "undo" | "redo";
    label: string;
    meta?: EntryMeta;
    /** Couldn't be done; the history was cut back here. */
    error?: string;
}

// Presses arriving while one is still moving files wait their turn, so
// rapid ⌘Z steps back one entry per press.
let queue: Promise<unknown> = Promise.resolve();

export function undo(): Promise<Applied | null> {
    const next = queue.then(() => step("undo"));
    queue = next.catch(() => {});
    return next;
}

export function redo(): Promise<Applied | null> {
    const next = queue.then(() => step("redo"));
    queue = next.catch(() => {});
    return next;
}

/** Moves in the step under way that followed a Finder rename (see runDisk). */
let followed: {
    op: MoveOp;
    direction: "undo" | "redo";
    src: string;
    dest: string;
    fileId: number;
    oldName: string;
    newName: string;
}[] = [];

/** Takes back a disk op of a step that failed part way. A move that
 *  followed a rename goes straight back to where it was found. */
async function revertDisk(op: DiskOp, direction: "undo" | "redo"): Promise<void> {
    const f = followed.find((x) => x.op === op);
    if (f) {
        ignore([f.src, f.dest]);
        await fs.rename(f.dest, f.src).catch(() => {});
        return;
    }
    await runDisk(op, direction === "undo" ? "redo" : "undo").catch(() => {});
}

async function step(direction: "undo" | "redo"): Promise<Applied | null> {
    if (busy || !db) return null;
    const from = direction === "undo" ? done : undone;
    const entry = from.at(-1);
    if (!entry) return null;
    busy = true;
    followed = [];
    const after: (() => void | Promise<void>)[] = [];
    try {
        // Disk first: if a file can't go back, the database is untouched.
        const ops = direction === "undo" ? [...entry.disk].reverse() : entry.disk;
        const moved: DiskOp[] = [];
        try {
            for (const op of ops) {
                after.push(await runDisk(op, direction));
                moved.push(op);
            }
        } catch (err) {
            // Put back what already moved, then cut the history here.
            for (const op of moved.reverse()) await revertDisk(op, direction);
            return fail(entry, direction, err);
        }

        try {
            const database = db;
            recording = true;
            const sql = [...entry.sql].reverse();
            database.transaction(() => {
                // Rows come back in reverse order; a child row may be
                // restored before the parent it points to.
                database.pragma("defer_foreign_keys = ON");
                for (const s of sql) database.exec(s);
                // The recorded rows carry the old name; a followed rename
                // keeps the new one (recorded too, so redo reverses it).
                const fix = database.prepare(`UPDATE files SET path = ?, filename = ? WHERE id = ?`);
                for (const f of followed) fix.run(rel(f.dest), f.newName, f.fileId);
            })();
            const rows = database
                .prepare(`SELECT sql FROM temp.undo_log ORDER BY seq`)
                .all() as { sql: string }[];
            entry.sql = rows.map((r) => r.sql);
        } catch (err) {
            for (const op of [...ops].reverse()) await revertDisk(op, direction);
            return fail(entry, direction, err);
        } finally {
            recording = false;
            db.exec(`DELETE FROM temp.undo_log`);
        }

        // A followed rename: the entry now names the file as it is, and its
        // paths are where the file really went, for the next undo or redo.
        for (const f of followed) {
            if (f.direction === "undo") {
                f.op.to = f.src;
                f.op.from = f.dest;
            } else {
                f.op.from = f.src;
                f.op.to = f.dest;
            }
            entry.label = entry.label.split(f.oldName).join(f.newName);
        }
        followed = [];

        from.pop();
        (direction === "undo" ? undone : done).push(entry);
        for (const fn of after) await fn();
        broadcastList();
        return { direction, label: entry.label, meta: entry.meta };
    } finally {
        busy = false;
    }
}

function fail(entry: Entry, direction: "undo" | "redo", err: unknown): Applied {
    console.error(`Couldn't ${direction} "${entry.label}":`, err);
    if (direction === "undo") {
        // This entry and everything older can no longer be reached.
        for (const e of done.splice(0)) purge(e, true);
    } else {
        for (const e of undone.splice(0)) purge(e, false);
    }
    broadcastList();
    const reason = err instanceof UndoBlocked ? err.message : "Something changed outside the app.";
    return { direction, label: entry.label, error: reason };
}

class UndoBlocked extends Error {}

// ── Disk ────────────────────────────────────────────────────────────────────

function send(channel: string, data?: unknown): void {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data);
}

function rel(abs: string): string {
    return path.relative(host!.rootPath()!, abs);
}

function insideLibrary(abs: string): boolean {
    const root = host?.rootPath();
    if (!root) return false;
    const r = path.relative(root, abs);
    return !r.startsWith("..") && !path.isAbsolute(r) && !r.startsWith(HOLDING_DIR);
}

/** Keeps the watcher off paths the app is moving, a little past the move
 *  (chokidar reports events after rename returns). */
function ignore(paths: string[]): void {
    const set = host!.ignoredPaths;
    for (const p of paths) set.add(p);
    setTimeout(() => paths.forEach((p) => set.delete(p)), 1500);
}

async function listFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
            const p = path.join(d, e.name);
            out.push(p);
            if (e.isDirectory()) await walk(p);
        }
    };
    await walk(dir);
    return out;
}

/** Moves one op's file(s) back (undo) or forward again (redo). Returns
 *  what to tell the renderer once the database matches. */
async function runDisk(op: DiskOp, direction: "undo" | "redo"): Promise<() => void | Promise<void>> {
    if (op.kind === "mkdir") {
        if (direction === "undo") {
            // Only while it's still empty (bar Finder's .DS_Store).
            const names = (await fs.readdir(op.path).catch(() => null)) ?? null;
            if (names == null) throw new UndoBlocked(`${op.relPath} was moved or deleted outside the app.`);
            if (names.some((n) => n !== ".DS_Store")) {
                throw new UndoBlocked(`${op.relPath} isn't empty any more.`);
            }
            await fs.rm(path.join(op.path, ".DS_Store"), { force: true });
            await fs.rmdir(op.path);
            return () => send("folder:removed", { relativePath: op.relPath });
        }
        if (existsSync(op.path)) throw new UndoBlocked(`Something named ${op.relPath} is already there.`);
        await fs.mkdir(op.path);
        return () => send("folder:added", { relativePath: op.relPath });
    }
    if (op.kind === "swap") {
        const file = host!.fileById(op.fileId);
        if (!file) throw new UndoBlocked("The file is no longer in the library.");
        const cur = path.join(host!.rootPath()!, file.path);
        if (!existsSync(cur) || !existsSync(op.held)) {
            throw new UndoBlocked(`${path.basename(cur)} was changed outside the app.`);
        }
        const tmp = `${op.held}.swap`;
        ignore([cur]);
        await fs.rename(cur, tmp);
        await fs.rename(op.held, cur);
        await fs.rename(tmp, op.held);
        return async () => {
            const fresh = host!.fileById(op.fileId);
            if (!fresh) return;
            await host!.ensureThumbnail(fresh.path).catch(() => {});
            send("media:updated", { relativePath: fresh.path, file: fresh });
        };
    }

    // A move: undo takes it from `to` back to `from`.
    const [srcPlanned, destPlanned] = direction === "undo" ? [op.to, op.from] : [op.from, op.to];
    let src = srcPlanned;
    let dest = destPlanned;
    const tracked = op.fileId != null ? host!.fileById(op.fileId) : undefined;
    if (tracked && insideLibrary(srcPlanned) && !op.folder) {
        // Follow a rename the watcher picked up since. A new name sticks:
        // the file goes back under the name it has now, not the old one.
        src = path.join(host!.rootPath()!, tracked.path);
        const oldName = path.basename(srcPlanned);
        const newName = path.basename(src);
        if (newName !== oldName && insideLibrary(destPlanned)) {
            dest = path.join(path.dirname(destPlanned), newName);
            followed.push({ op, direction, src, dest, fileId: op.fileId!, oldName, newName });
        }
    }
    const name = path.basename(dest);
    if (!existsSync(src)) throw new UndoBlocked(`${name} was moved or deleted outside the app.`);
    if (existsSync(dest)) throw new UndoBlocked(`Something named ${name} is already there.`);
    if (isHeld(dest)) await fs.mkdir(path.dirname(dest), { recursive: true });
    else if (!existsSync(path.dirname(dest))) {
        throw new UndoBlocked(`The folder ${name} was in no longer exists.`);
    }

    const srcIn = insideLibrary(src);
    const destIn = insideLibrary(dest);
    // A file from outside the library (dropped in): the watcher indexes or
    // drops it, as for any file moved in or out in Finder.
    const external = op.fileId == null && !op.folder;
    if (!external) {
        const paths = [src, dest];
        if (op.folder) {
            for (const p of await listFiles(src)) {
                paths.push(p, path.join(dest, path.relative(src, p)));
            }
        }
        ignore(paths);
    }
    await fs.rename(src, dest);
    if (external) return () => {};

    return () => {
        if (op.folder?.mode === "rename") {
            const [oldRel, newRel] =
                direction === "undo" ? [op.folder.toRel, op.folder.fromRel] : [op.folder.fromRel, op.folder.toRel];
            for (const f of host!.filesUnder(newRel)) {
                send("media:renamed", {
                    oldRelativePath: oldRel + f.path.slice(newRel.length),
                    relativePath: f.path,
                    hash: f.content_hash,
                    mediaType: f.media_type,
                });
            }
            send("folder:renamed", { oldRelativePath: oldRel, relativePath: newRel });
            return;
        }
        if (op.folder) {
            if (destIn) send("folder:added", { relativePath: op.folder.fromRel });
            for (const id of op.folder.fileIds) {
                const f = host!.fileById(id);
                if (!f) continue;
                if (destIn) {
                    send("media:added", { relativePath: f.path, hash: f.content_hash, mediaType: f.media_type });
                } else {
                    send("media:removed", { relativePath: f.path });
                }
            }
            if (srcIn) send("folder:removed", { relativePath: op.folder.fromRel });
            return;
        }
        const f = host!.fileById(op.fileId!);
        if (!f) return;
        if (srcIn && destIn) {
            send("media:renamed", {
                oldRelativePath: rel(src),
                relativePath: rel(dest),
                hash: f.content_hash,
                mediaType: f.media_type,
            });
        } else if (destIn) {
            send("media:added", { relativePath: rel(dest), hash: f.content_hash, mediaType: f.media_type });
        } else {
            send("media:removed", { relativePath: rel(src) });
        }
    };
}

function isHeld(abs: string): boolean {
    return abs.includes(`${path.sep}${HOLDING_DIR}${path.sep}`);
}

/** Held files an entry owns in its current state. */
function heldBy(entry: Entry, isDone: boolean): string[] {
    const out: string[] = [];
    for (const op of entry.disk) {
        if (op.kind === "swap") out.push(op.held);
        // A delete holds its file while it's done; once undone it's back.
        else if (op.kind === "move" && isDone && isHeld(op.to)) out.push(op.to);
    }
    return out;
}

/** An entry leaves the history: its held files go to the Trash (or, for
 *  discards, are deleted). */
function purge(entry: Entry, isDone: boolean): void {
    for (const p of heldBy(entry, isDone)) {
        if (existsSync(p)) {
            releaseHeld(p).catch((err) => console.error("Couldn't release held file:", p, err));
        }
    }
}

/** Empties the history (library switched or closed). Held files go to
 *  the Trash. */
export function clearHistory(): void {
    for (const e of done.splice(0)) purge(e, true);
    for (const e of undone.splice(0)) purge(e, false);
    broadcastList();
}

/** Empties a library's holding folder (quitting, or leftovers from a crash
 *  at launch): to the Trash, except discards, which are deleted. */
export async function flushHolding(root: string): Promise<void> {
    const dir = path.join(root, HOLDING_DIR);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
        if (n === ".DS_Store") continue;
        await releaseHeld(path.join(dir, n)).catch((err) =>
            console.error("Couldn't release held file:", n, err),
        );
    }
    await fs.rm(path.join(dir, ".DS_Store"), { force: true }).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
}

export function hasHeldFiles(root: string): boolean {
    return existsSync(path.join(root, HOLDING_DIR));
}

function broadcastList(): void {
    send("history:changed", historyList());
}
