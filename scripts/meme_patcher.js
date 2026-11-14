#!/usr/bin/env node
"use strict";
/**
 * agy-meme Standalone Electron ASAR Overlay Patcher (macOS / Windows / Linux)
 *
 * 将双向表情包渲染器与主进程 IPC 叠加注入 Antigravity Desktop 的 app.asar：
 * - 支持原版英文 Antigravity Desktop，亦支持叠加在 antigravity-desktop-cn 中文汉化包之上；
 * - 首次注入若尚无 app.asar.bak，自动备份纯净官方包，确保汉化与卸载互不覆盖；
 * - 卸载 (--uninstall) 仅剥离 agy-meme 标记区块，绝不破坏已安装的中文汉化；
 * - macOS 自动执行 quarantine 清理与 Inside-Out ad-hoc 自签名。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const child_process = require("child_process");
const vm = require("vm");

if (process.platform === "win32") {
    const defaultNodePaths = [
        "C:\\Program Files\\nodejs",
        "C:\\Program Files (x86)\\nodejs",
        path.join(process.env.LOCALAPPDATA || "", "Programs", "node"),
        path.join(process.env.APPDATA || "", "npm")
    ];
    for (const nodePath of defaultNodePaths) {
        if (fs.existsSync(nodePath) && !String(process.env.PATH || "").includes(nodePath)) {
            process.env.PATH = nodePath + ";" + (process.env.PATH || "");
        }
    }
}

const IPC_MEME_SIGNATURE_START = "'__ANTIGRAVITY_IPC_MEME_START__';";
const IPC_MEME_SIGNATURE_END = "'__ANTIGRAVITY_IPC_MEME_END__';";
const PRELOAD_MEME_SIGNATURE_START = "'__ANTIGRAVITY_MEME_RENDERER_START__';";
const PRELOAD_MEME_SIGNATURE_END = "'__ANTIGRAVITY_MEME_RENDERER_END__';";
const MEME_RENDERER_MARKER = "ag-meme-renderer-v2";

function __agRegisterMemeIpcHandlers(electron_1) {
    const fsSync = require("fs");
    const pathMod = require("path");
    const osMod = require("os");
    const cryptoMod = require("crypto");
    const { execFileSync } = require("child_process");

    const HOME = osMod.homedir();
    const CONFIG_PATH = pathMod.join(HOME, ".gemini", "meme-config.json");
    const DEFAULT_PACKS_DIR = pathMod.join(HOME, ".gemini", "meme-packs");
    const BUNDLED_PLUGIN_PACKS_DIR = pathMod.join(HOME, ".gemini", "config", "plugins", "agy-meme", "packs");
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const ALLOWED_EXTS = {
        ".webp": "image/webp",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif"
    };
    const VALID_MOODS = new Set(["happy", "shy", "angry", "sad", "confused", "daily"]);
    const allowedPackDirs = new Map();

    function assertMainFrame(event) {
        if (event && event.senderFrame && event.senderFrame.parent) {
            throw new Error("Unauthorized subframe Meme IPC call");
        }
    }

    function expandHome(p) {
        const s = String(p || "").trim();
        if (!s) return "";
        if (s === "~") return HOME;
        if (s.startsWith("~/") || s.startsWith("~\\")) return pathMod.join(HOME, s.slice(2));
        return s;
    }

    function readConfig() {
        const def = {
            enabled: true,
            pickerSendOnClick: true,
            layoutMode: "inline",
            stickerSize: 168,
            activePacks: ["gemini-neko"],
            packsDirs: [DEFAULT_PACKS_DIR]
        };
        try {
            if (!fsSync.existsSync(CONFIG_PATH)) return def;
            const parsed = JSON.parse(fsSync.readFileSync(CONFIG_PATH, "utf8"));
            if (!parsed || typeof parsed !== "object") return def;
            const packsDirs = Array.isArray(parsed.packsDirs) && parsed.packsDirs.length > 0
                ? parsed.packsDirs.map(expandHome).filter(Boolean)
                : [DEFAULT_PACKS_DIR];
            const activePacks = Array.isArray(parsed.activePacks) && parsed.activePacks.length > 0
                ? parsed.activePacks.map(String).filter(Boolean)
                : ["gemini-neko"];
            return {
                enabled: parsed.enabled !== false,
                pickerSendOnClick: parsed.pickerSendOnClick !== false,
                layoutMode: parsed.layoutMode === "stacked" ? "stacked" : "inline",
                stickerSize: Number(parsed.stickerSize) > 60 ? Math.min(280, Number(parsed.stickerSize)) : 168,
                activePacks,
                packsDirs
            };
        } catch (e) {
            return def;
        }
    }

    function saveConfig(patch) {
        const current = readConfig();
        const next = Object.assign({}, current);
        if (patch && typeof patch === "object") {
            if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
            if (typeof patch.pickerSendOnClick === "boolean") next.pickerSendOnClick = patch.pickerSendOnClick;
            if (patch.layoutMode === "stacked" || patch.layoutMode === "inline") next.layoutMode = patch.layoutMode;
            if (Number.isFinite(Number(patch.stickerSize)) && Number(patch.stickerSize) >= 80) {
                next.stickerSize = Math.min(280, Math.round(Number(patch.stickerSize)));
            }
            if (Array.isArray(patch.activePacks) && patch.activePacks.length > 0) {
                next.activePacks = patch.activePacks.map(String).filter(Boolean);
            }
        }
        try {
            fsSync.mkdirSync(pathMod.dirname(CONFIG_PATH), { recursive: true });
            const serializable = Object.assign({}, next, {
                packsDirs: next.packsDirs.map((d) => (d === DEFAULT_PACKS_DIR ? "~/.gemini/meme-packs" : d))
            });
            fsSync.writeFileSync(CONFIG_PATH, JSON.stringify(serializable, null, 2) + "\n", "utf8");
        } catch (e) {}
        return next;
    }

    function walkImagesFallback(packDir) {
        const out = [];
        const walk = (dir, prefix) => {
            let entries = [];
            try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (let i = 0; i < entries.length; i++) {
                const ent = entries[i];
                if (ent.name.startsWith(".") || ent.name === "manifest.json" || ent.name === "memes.json" || ent.name.startsWith("index.db")) continue;
                const full = pathMod.join(dir, ent.name);
                const rel = prefix ? prefix + "/" + ent.name : ent.name;
                if (ent.isDirectory()) {
                    walk(full, rel);
                    continue;
                }
                if (!ent.isFile()) continue;
                const ext = pathMod.extname(ent.name).toLowerCase();
                if (!ALLOWED_EXTS[ext]) continue;
                const segs = rel.replace(/^memes\//, "").split("/");
                const tag = segs.length >= 2 && VALID_MOODS.has(segs[0].toLowerCase()) ? segs[0].toLowerCase() : "daily";
                const stem = ent.name.slice(0, ent.name.length - ext.length);
                out.push({ path: rel, tag, file_name: ent.name, caption: stem, keywords: stem });
            }
        };
        walk(packDir, "");
        return out;
    }

    function readPackRows(packDir) {
        const memesJsonPath = pathMod.join(packDir, "memes.json");
        if (fsSync.existsSync(memesJsonPath)) {
            try {
                const parsed = JSON.parse(fsSync.readFileSync(memesJsonPath, "utf8"));
                const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.memes) ? parsed.memes : []);
                if (arr.length > 0) return arr;
            } catch (e) {}
        }
        const dbPath = pathMod.join(packDir, "index.db");
        if (fsSync.existsSync(dbPath)) {
            try {
                const sqliteBin = fsSync.existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
                const raw = execFileSync(sqliteBin, ["-readonly", "-json", dbPath, "SELECT path, tag, file_name, caption, keywords FROM memes;"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
                const rows = JSON.parse(raw || "[]");
                if (Array.isArray(rows) && rows.length > 0) return rows;
            } catch (e) {}
        }
        return walkImagesFallback(packDir);
    }

    function discoverPacks(cfg) {
        allowedPackDirs.clear();
        const packs = [];
        const seen = new Set();
        const dirs = (Array.isArray(cfg.packsDirs) && cfg.packsDirs.length > 0 ? cfg.packsDirs.slice() : [DEFAULT_PACKS_DIR]);
        if (!dirs.some((d) => pathMod.resolve(expandHome(d)) === pathMod.resolve(BUNDLED_PLUGIN_PACKS_DIR))) {
            dirs.push(BUNDLED_PLUGIN_PACKS_DIR);
        }
        for (let i = 0; i < dirs.length; i++) {
            const root = pathMod.resolve(expandHome(dirs[i]));
            if (!fsSync.existsSync(root)) continue;
            let names = [];
            try { names = fsSync.readdirSync(root); } catch (e) { continue; }
            for (let j = 0; j < names.length; j++) {
                const name = names[j];
                if (!name || name.startsWith(".") || seen.has(name)) continue;
                const pDir = pathMod.resolve(pathMod.join(root, name));
                try { if (!fsSync.statSync(pDir).isDirectory()) continue; } catch (e) { continue; }
                const hasMeta = fsSync.existsSync(pathMod.join(pDir, "memes.json")) || fsSync.existsSync(pathMod.join(pDir, "index.db")) || fsSync.existsSync(pathMod.join(pDir, "memes"));
                if (!hasMeta) continue;
                seen.add(name);
                allowedPackDirs.set(name, pDir);
                let manifest = { id: name, name: name, description: "" };
                try {
                    const mPath = pathMod.join(pDir, "manifest.json");
                    if (fsSync.existsSync(mPath)) {
                        manifest = Object.assign(manifest, JSON.parse(fsSync.readFileSync(mPath, "utf8")));
                    }
                } catch (e) {}
                const rows = readPackRows(pDir);
                packs.push({
                    id: name,
                    name: String(manifest.name || name),
                    description: String(manifest.description || ""),
                    active: cfg.activePacks.includes(name),
                    count: rows.length,
                    rows
                });
            }
        }
        return packs;
    }

    function syncSqliteBestEffort(packDir, rows) {
        const dbPath = pathMod.join(packDir, "index.db");
        const pyScript = [
            "import json, sqlite3, sys",
            "d = json.loads(sys.stdin.read())",
            "conn = sqlite3.connect(d['dbPath'])",
            "conn.execute('''CREATE TABLE IF NOT EXISTS memes (path TEXT PRIMARY KEY, tag TEXT NOT NULL, file_name TEXT NOT NULL, file_hash TEXT, caption TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', mtime REAL, captioned_at REAL)''')",
            "conn.execute('DELETE FROM memes')",
            "for r in d['rows']:",
            "    conn.execute('INSERT INTO memes(path, tag, file_name, file_hash, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (r.get('path',''), r.get('tag','daily'), r.get('file_name',''), r.get('file_hash',''), r.get('caption',''), r.get('keywords',''), r.get('mtime'), r.get('captioned_at')))",
            "conn.commit()",
            "conn.close()"
        ].join("\n");
        try {
            execFileSync("python3", ["-c", pyScript], {
                input: JSON.stringify({ dbPath, rows }),
                encoding: "utf8",
                stdio: ["pipe", "ignore", "ignore"]
            });
        } catch (e) {}
    }

    try { electron_1.ipcMain.removeHandler("ag-ux:meme-list"); } catch (e) {}
    electron_1.ipcMain.handle("ag-ux:meme-list", async (event) => {
        assertMainFrame(event);
        try {
            const cfg = readConfig();
            const discovered = discoverPacks(cfg);
            const activeSet = new Set(cfg.activePacks);
            const packs = [];
            const memes = [];
            for (let i = 0; i < discovered.length; i++) {
                const p = discovered[i];
                packs.push({ id: p.id, name: p.name, description: p.description, count: p.count, active: p.active });
                if (!activeSet.has(p.id) && discovered.length > 0 && cfg.activePacks.length > 0) continue;
                for (let k = 0; k < p.rows.length; k++) {
                    const r = p.rows[k];
                    if (!r || !r.path) continue;
                    memes.push({
                        packId: p.id,
                        packName: p.name,
                        path: String(r.path),
                        tag: String(r.tag || "daily").toLowerCase(),
                        file_name: String(r.file_name || pathMod.basename(String(r.path))),
                        caption: String(r.caption || ""),
                        keywords: String(r.keywords || "")
                    });
                }
            }
            return { ok: true, config: cfg, packs, memes };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    });

    try { electron_1.ipcMain.removeHandler("ag-ux:meme-read-image"); } catch (e) {}
    electron_1.ipcMain.handle("ag-ux:meme-read-image", async (event, payload) => {
        assertMainFrame(event);
        try {
            const packId = String((payload && payload.packId) || "").trim();
            const relPath = String((payload && payload.relPath) || "").trim().replace(/\\/g, "/");
            if (!packId || !relPath) return { ok: false, error: "参数不完整" };
            let packDir = allowedPackDirs.get(packId);
            if (!packDir) {
                discoverPacks(readConfig());
                packDir = allowedPackDirs.get(packId);
            }
            if (!packDir) return { ok: false, error: "未知表情包图库: " + packId };
            const resolvedPack = pathMod.resolve(packDir);
            const absPath = pathMod.resolve(resolvedPack, relPath);
            if (!absPath.startsWith(resolvedPack + pathMod.sep)) {
                return { ok: false, error: "非法路径访问" };
            }
            const ext = pathMod.extname(absPath).toLowerCase();
            const mime = ALLOWED_EXTS[ext];
            if (!mime) return { ok: false, error: "不支持的图片格式" };
            if (!fsSync.existsSync(absPath)) return { ok: false, error: "图片文件不存在" };
            const st = fsSync.statSync(absPath);
            if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return { ok: false, error: "图片体积超限" };
            const data = fsSync.readFileSync(absPath);
            return { ok: true, mime, data };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    });

    try { electron_1.ipcMain.removeHandler("ag-ux:meme-save-config"); } catch (e) {}
    electron_1.ipcMain.handle("ag-ux:meme-save-config", async (event, patch) => {
        assertMainFrame(event);
        try {
            const next = saveConfig(patch);
            return { ok: true, config: next };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    });

    try { electron_1.ipcMain.removeHandler("ag-ux:meme-pick-file"); } catch (e) {}
    electron_1.ipcMain.handle("ag-ux:meme-pick-file", async (event) => {
        assertMainFrame(event);
        try {
            const win = electron_1.BrowserWindow && typeof electron_1.BrowserWindow.fromWebContents === "function"
                ? electron_1.BrowserWindow.fromWebContents(event.sender)
                : null;
            const opts = {
                title: "选择要收录到 Gemini 猫娘表情库的图片",
                properties: ["openFile"],
                filters: [{ name: "Images", extensions: ["webp", "png", "jpg", "jpeg", "gif"] }]
            };
            const res = win ? await electron_1.dialog.showOpenDialog(win, opts) : await electron_1.dialog.showOpenDialog(opts);
            if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
                return { ok: true, canceled: true };
            }
            const filePath = res.filePaths[0];
            const ext = pathMod.extname(filePath).toLowerCase();
            const mime = ALLOWED_EXTS[ext];
            if (!mime) return { ok: false, error: "仅支持 webp / png / jpg / gif 格式" };
            const st = fsSync.statSync(filePath);
            if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return { ok: false, error: "图片不能超过 8 MB" };
            const data = fsSync.readFileSync(filePath);
            const stem = pathMod.basename(filePath, ext).slice(0, 80);
            return { ok: true, canceled: false, filePath, mime, data, suggestedCaption: stem };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    });

    try { electron_1.ipcMain.removeHandler("ag-ux:meme-import-commit"); } catch (e) {}
    electron_1.ipcMain.handle("ag-ux:meme-import-commit", async (event, payload) => {
        assertMainFrame(event);
        try {
            const srcPath = String((payload && payload.srcPath) || "").trim();
            const caption = String((payload && payload.caption) || "").trim().slice(0, 120);
            const rawTag = String((payload && payload.tag) || "daily").trim().toLowerCase();
            const tag = VALID_MOODS.has(rawTag) ? rawTag : "daily";
            const keywords = String((payload && payload.keywords) || "").trim() || caption;
            const packId = String((payload && payload.packId) || "gemini-neko").trim() || "gemini-neko";
            if (!srcPath || !fsSync.existsSync(srcPath)) return { ok: false, error: "源图片文件不存在" };
            if (!caption) return { ok: false, error: "请填写表情描述" };
            const ext = pathMod.extname(srcPath).toLowerCase();
            if (!ALLOWED_EXTS[ext]) return { ok: false, error: "不支持的图片格式: " + ext };
            const packDir = pathMod.join(DEFAULT_PACKS_DIR, packId);
            if (!fsSync.existsSync(pathMod.join(packDir, "memes.json"))) {
                const bundledDir = pathMod.join(BUNDLED_PLUGIN_PACKS_DIR, packId);
                if (fsSync.existsSync(bundledDir) && typeof fsSync.cpSync === "function") {
                    try { fsSync.mkdirSync(DEFAULT_PACKS_DIR, { recursive: true }); fsSync.cpSync(bundledDir, packDir, { recursive: true }); } catch (e) {}
                }
            }
            const tagDir = pathMod.join(packDir, "memes", tag);
            fsSync.mkdirSync(tagDir, { recursive: true });

            const asciiSlug = caption.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
            const baseSlug = asciiSlug.length >= 3 ? asciiSlug.slice(0, 40) : ("sticker-" + cryptoMod.createHash("sha1").update(caption + Date.now()).digest("hex").slice(0, 8));
            let fileName = baseSlug + ext;
            let relPath = "memes/" + tag + "/" + fileName;
            let dest = pathMod.join(packDir, relPath);
            if (fsSync.existsSync(dest)) {
                fileName = baseSlug + "-" + Date.now().toString(36) + ext;
                relPath = "memes/" + tag + "/" + fileName;
                dest = pathMod.join(packDir, relPath);
            }
            fsSync.copyFileSync(srcPath, dest);
            const bytes = fsSync.readFileSync(dest);
            const fhash = cryptoMod.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
            const st = fsSync.statSync(dest);
            const nowSec = Date.now() / 1000;

            let manifest = { id: packId, name: packId === "gemini-neko" ? "Gemini猫娘" : packId, version: "1.1.0" };
            const mPath = pathMod.join(packDir, "manifest.json");
            if (fsSync.existsSync(mPath)) {
                try { manifest = Object.assign(manifest, JSON.parse(fsSync.readFileSync(mPath, "utf8"))); } catch (e) {}
            }
            let rows = readPackRows(packDir);
            const newRow = {
                path: relPath,
                tag,
                file_name: fileName,
                file_hash: fhash,
                caption,
                keywords,
                mtime: st.mtimeMs / 1000,
                captioned_at: nowSec
            };
            rows.push(newRow);
            manifest.count = rows.length;
            fsSync.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
            fsSync.writeFileSync(pathMod.join(packDir, "memes.json"), JSON.stringify({ manifest, memes: rows }, null, 2) + "\n", "utf8");
            syncSqliteBestEffort(packDir, rows);
            allowedPackDirs.set(packId, packDir);
            return { ok: true, row: Object.assign({ packId, packName: manifest.name }, newRow) };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    });

    try { electron_1.ipcMain.removeHandler("ag-ux:meme-open-pack-dir"); } catch (e) {}
    electron_1.ipcMain.handle("ag-ux:meme-open-pack-dir", async (event) => {
        assertMainFrame(event);
        try {
            fsSync.mkdirSync(DEFAULT_PACKS_DIR, { recursive: true });
            const errMsg = await electron_1.shell.openPath(DEFAULT_PACKS_DIR);
            return { ok: !errMsg, error: errMsg || null, path: DEFAULT_PACKS_DIR };
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    });
}

function __agSetupMemeRenderer(invokeFn) {
    if (!invokeFn || typeof document === "undefined") return;

    const STYLE_ID = "ag-ux-meme-style";
    const MEME_RENDERER_MARKER = "ag-meme-renderer-v2";
    const MEME_RE = /\[表情[:：]\s*([^\[\]\r\n]+?)\](?:\((?:https?:\/\/[^)\s]+)\))?/g;
    const MEME_TEST_RE = /\[表情[:：]\s*([^\[\]\r\n]+?)\](?:\((?:https?:\/\/[^)\s]+)\))?/;
    const BUBBLE_SEL = [
        '[data-markdown-root]',
        '[data-testid="planner-response-text"]',
        '[data-testid="progress-update-response-text"]',
        '[data-bubble-side="agent"]',
        '[data-testid="transcript-line-text"]',
        '[data-testid="user-message-content"]',
        '[data-testid="user-message-bubble"]'
    ].join(', ');
    const SKIP_ANCESTOR_SEL = 'pre, code, kbd, samp, style, script, svg, math, noscript, template, textarea, input, select, [contenteditable="true"], a, button, .monaco-editor, .google-symbols, .codicon, .context-scope-mention, [data-testid="markdown-code-block-preview"], [data-ag-meme-slot], [data-ag-meme-board], [data-ag-meme-zoom]';
    const BLOCK_BREAK_TAGS = new Set([
        "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS",
        "DIALOG", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
        "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
        "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
        "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"
    ]);

    const MOOD_TABS = [
        { id: "all", label: "全部" },
        { id: "happy", label: "开心" },
        { id: "shy", label: "害羞" },
        { id: "angry", label: "哈气" },
        { id: "sad", label: "哭哭" },
        { id: "confused", label: "懵懂" },
        { id: "daily", label: "日常" }
    ];

    let libState = null;
    let configOverride = null;
    let configOverrideSeq = 0;
    let libPromise = null;
    let libRetryAfter = 0;
    let libRetryTimer = null;
    const blobCache = new Map();

    function getActiveMemeConfig() {
        return (libState && libState.config) || configOverride || { enabled: true, pickerSendOnClick: true, stickerSize: 168 };
    }

    let boardEl = null;
    let boardOpen = false;
    let activeComposer = null;
    let boardState = {
        mood: "all",
        query: "",
        hovered: null,
        importDraft: null
    };

    let zoomBox = null;
    let zoomImg = null;
    let zoomTip = null;
    let zoomScale = 1;

    function foldCaption(s) {
        return String(s || "")
            .trim()
            .replace(/[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f«»]/g, '"')
            .replace(/\s+/g, " ");
    }

    function looseCaption(s) {
        return foldCaption(s).replace(/["'\s·・!！?？.,，。~～\-_]/g, "").toLowerCase();
    }

    function splitDescTokens(s) {
        return foldCaption(s)
            .split(/[\s,.!?;:、，。！？；：""''()（）\[\]【】《》…·・～~\-_]+/)
            .map((t) => t.replace(/["']/g, "").toLowerCase())
            .filter((t) => t.length >= 2)
            .sort((a, b) => b.length - a.length);
    }

    function buildLookup(memes) {
        const captionMap = new Map();
        const keywordMap = new Map();
        const searchList = [];

        const regKey = (map, rawKey, row) => {
            const raw = String(rawKey || "").trim();
            if (!raw) return;
            const forms = new Set([raw, foldCaption(raw), looseCaption(raw)]);
            forms.forEach((f) => {
                if (f && !map.has(f)) map.set(f, row);
            });
        };

        for (let i = 0; i < memes.length; i++) {
            const m = memes[i];
            regKey(captionMap, m.caption, m);
            const fname = String(m.file_name || "");
            const dot = fname.lastIndexOf(".");
            const stem = dot > 0 ? fname.slice(0, dot) : fname;
            regKey(captionMap, stem, m);
            regKey(captionMap, String(m.caption || "").slice(0, 80), m);

            const kwStr = String(m.keywords || "");
            regKey(keywordMap, kwStr, m);
            const kws = kwStr.split(/\s+/);
            for (let j = 0; j < kws.length; j++) regKey(keywordMap, kws[j], m);

            const hay = [];
            const tokensSource = [m.caption, m.keywords, stem].filter(Boolean);
            for (let j = 0; j < tokensSource.length; j++) {
                const fc = foldCaption(tokensSource[j]).toLowerCase();
                const lc = looseCaption(tokensSource[j]);
                if (fc) hay.push(fc);
                if (lc && lc !== fc) hay.push(lc);
            }
            searchList.push({
                row: m,
                hay,
                tokens: Array.from(new Set(splitDescTokens(tokensSource.join(" "))))
            });
        }

        return { captionMap, keywordMap, searchList };
    }

    function resolveMeme(desc) {
        if (!libState || !libState.lookup) return null;
        const { captionMap, keywordMap, searchList } = libState.lookup;
        const raw = String(desc || "").trim();
        const forms = [raw, foldCaption(raw), looseCaption(raw)];
        const maps = [captionMap, keywordMap];
        for (let mi = 0; mi < maps.length; mi++) {
            const mp = maps[mi];
            for (let fi = 0; fi < forms.length; fi++) {
                const f = forms[fi];
                if (f && mp.has(f)) return mp.get(f);
            }
        }
        const needles = Array.from(new Set(splitDescTokens(raw).map(looseCaption).filter(Boolean)));
        let best = null;
        let bestLen = 0;
        let bestCnt = 0;
        for (let i = 0; i < searchList.length; i++) {
            const item = searchList[i];
            let longest = 0;
            let cnt = 0;
            for (let ni = 0; ni < needles.length; ni++) {
                const n = needles[ni];
                let hitLen = item.hay.some((h) => h.includes(n)) ? n.length : 0;
                for (let ti = 0; ti < item.tokens.length; ti++) {
                    const t = looseCaption(item.tokens[ti]);
                    if (t && (n.includes(t) || t.includes(n))) {
                        hitLen = Math.max(hitLen, Math.min(n.length, t.length));
                    }
                }
                if (hitLen > 0) {
                    longest = Math.max(longest, hitLen);
                    cnt++;
                }
            }
            if (longest > bestLen || (longest === bestLen && cnt > bestCnt)) {
                best = item.row;
                bestLen = longest;
                bestCnt = cnt;
            }
        }
        return best;
    }

    function bytesToBase64(bytes) {
        if (!bytes || !bytes.length) return "";
        const chunkSize = 0x8000;
        const parts = [];
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            parts.push(String.fromCharCode.apply(null, sub));
        }
        return btoa(parts.join(""));
    }

    function getMemeImageAsset(meme) {
        if (!meme || !meme.packId || !meme.path) return Promise.resolve(null);
        const key = meme.packId + "::" + meme.path;
        if (blobCache.has(key)) return blobCache.get(key);
        const p = invokeFn("ag-ux:meme-read-image", { packId: meme.packId, relPath: meme.path })
            .then((res) => {
                if (!res || !res.ok || !res.data) {
                    blobCache.delete(key);
                    return null;
                }
                const bytes = res.data instanceof Uint8Array
                    ? res.data
                    : (ArrayBuffer.isView(res.data)
                        ? new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength)
                        : new Uint8Array(res.data));
                const mime = res.mime || "image/webp";
                let blobUrl = null;
                try {
                    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
                        blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
                    }
                } catch (_) {
                    blobUrl = null;
                }
                let dataUrl = null;
                const getDataUrl = () => {
                    if (dataUrl) return dataUrl;
                    try {
                        dataUrl = "data:" + mime + ";base64," + bytesToBase64(bytes);
                    } catch (_) {
                        dataUrl = null;
                    }
                    return dataUrl;
                };
                return {
                    mime,
                    bytes,
                    blobUrl: blobUrl || getDataUrl(),
                    getDataUrl
                };
            })
            .catch(() => {
                blobCache.delete(key);
                return null;
            });
        blobCache.set(key, p);
        return p;
    }

    function scheduleLibraryRetry() {
        if (libRetryTimer) return;
        libRetryTimer = window.setTimeout(() => {
            libRetryTimer = null;
            if (!libState && typeof globalThis.__agScheduleMemeSync === "function") {
                globalThis.__agScheduleMemeSync();
            }
        }, 3200);
    }

    function ensureLibrary(forceRefresh) {
        if (!forceRefresh && libState) return Promise.resolve(libState);
        if (!forceRefresh && libPromise) return libPromise;
        if (!forceRefresh && Date.now() < libRetryAfter) {
            scheduleLibraryRetry();
            return Promise.resolve(null);
        }
        const reqSeq = configOverrideSeq;
        libPromise = invokeFn("ag-ux:meme-list")
            .then((res) => {
                libPromise = null;
                if (!res || !res.ok) {
                    libRetryAfter = Date.now() + 3000;
                    scheduleLibraryRetry();
                    try { console.warn("[AG-UX Meme] meme-list returned not ok:", res && res.error); } catch (_) {}
                    return null;
                }
                const memes = Array.isArray(res.memes) ? res.memes : [];
                const packs = Array.isArray(res.packs) ? res.packs : [];
                const config = Object.assign({ enabled: true, pickerSendOnClick: true, stickerSize: 168 }, res.config || {});
                if (configOverride && configOverrideSeq > reqSeq) {
                    Object.assign(config, configOverride);
                } else {
                    configOverride = null;
                }
                libState = {
                    config,
                    packs,
                    memes,
                    lookup: buildLookup(memes)
                };
                libRetryAfter = 0;
                if (libRetryTimer) {
                    clearTimeout(libRetryTimer);
                    libRetryTimer = null;
                }
                if (typeof globalThis.__agScheduleMemeSync === "function") {
                    globalThis.__agScheduleMemeSync();
                }
                return libState;
            })
            .catch((err) => {
                libPromise = null;
                libRetryAfter = Date.now() + 3000;
                scheduleLibraryRetry();
                try { console.warn("[AG-UX Meme] meme-list IPC error:", err && err.message ? err.message : err); } catch (_) {}
                return null;
            });
        return libPromise;
    }

    function ensureMemeStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const host = document.head || document.documentElement;
        if (!host) return;
        const st = document.createElement("style");
        st.id = STYLE_ID;
        st.setAttribute("data-ag-meme-ver", MEME_RENDERER_MARKER);
        st.textContent = [
            '.ag-meme-slot{display:inline-flex;flex-direction:column;align-items:flex-start;vertical-align:middle;margin:4px 6px 4px 0;max-width:100%}',
            '.ag-meme-slot[data-ag-meme-standalone="1"]{display:flex;margin:6px 0}',
            '.ag-meme-slot[data-ag-meme-multi="1"]{display:inline-flex;vertical-align:top;margin:3px 6px 3px 0}',
            '[data-testid="user-message-bubble"] .ag-meme-slot[data-ag-meme-standalone="1"]{margin:2px 0}',
            '[data-testid="user-message-content"] .ag-meme-slot[data-ag-meme-standalone="1"]{align-items:flex-end;margin:2px 0}',
            '[data-testid="user-message-bubble"] .ag-meme-slot[data-ag-meme-multi="1"],[data-testid="user-message-content"] .ag-meme-slot[data-ag-meme-multi="1"]{align-items:flex-start;margin:2px 6px 2px 0}',
            '[data-testid="user-message-content"]:has([data-ag-meme-slot]),[data-testid="user-message-bubble"] > div:has([data-ag-meme-slot]){max-height:min(70vh,560px) !important;overflow-y:auto !important;overflow-x:visible !important;-webkit-mask-image:none !important;mask-image:none !important}',
            '[data-testid="user-message-bubble"]:has([data-ag-meme-slot]){overflow:visible !important}',
            '[data-testid="user-message-content"][data-ag-meme-unclip="1"],[data-testid="user-message-bubble"] > div[data-ag-meme-unclip="1"],[data-testid="user-message-bubble"][data-ag-meme-unclip="1"]{max-height:none !important;overflow:visible !important;-webkit-mask-image:none !important;mask-image:none !important}',
            '.ag-meme-img{max-width:min(var(--ag-meme-size,168px),100%);max-height:var(--ag-meme-size,168px);width:auto;height:auto;border-radius:10px;display:block;cursor:zoom-in;object-fit:contain;transition:transform .14s ease,box-shadow .14s ease}',
            '.ag-meme-img:hover{transform:scale(1.03);box-shadow:0 6px 18px rgba(0,0,0,.22)}',
            '.ag-meme-fallback{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;font-size:12px;border:1px solid var(--border,rgba(128,128,128,.3));background:var(--secondary,rgba(128,128,128,.12));color:var(--foreground,inherit)}',
            '.ag-meme-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:9999px;border:none;background:transparent;color:var(--muted-foreground,#9ca3af);cursor:pointer;transition:background-color .15s,color .15s;flex-shrink:0}',
            '.ag-meme-trigger:hover,.ag-meme-trigger[data-active="true"]{background:var(--secondary,rgba(128,128,128,.18));color:var(--foreground,#fff)}',
            '.ag-meme-board{position:fixed;z-index:2147482500;width:388px;max-width:calc(100vw - 24px);height:452px;max-height:calc(100vh - 36px);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--border,rgba(128,128,128,.28));background:var(--popover,var(--card,#1e1e24));color:var(--foreground,#f4f4f5);box-shadow:0 16px 48px rgba(0,0,0,.38);overflow:hidden;font-family:inherit}',
            '.ag-meme-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--border,rgba(128,128,128,.2));flex-shrink:0}',
            '.ag-meme-head-left{display:flex;align-items:center;gap:6px;min-width:0}',
            '.ag-meme-title{font-size:13px;font-weight:600;white-space:nowrap}',
            '.ag-meme-count{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--secondary,rgba(128,128,128,.16));color:var(--muted-foreground,#a1a1aa)}',
            '.ag-meme-head-acts{display:flex;align-items:center;gap:4px}',
            '.ag-meme-pill-btn{height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--border,rgba(128,128,128,.25));background:transparent;color:var(--foreground,inherit);font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}',
            '.ag-meme-pill-btn:hover{background:var(--secondary,rgba(128,128,128,.18))}',
            '.ag-meme-pill-btn[data-on="true"]{border-color:var(--primary,#6366f1);color:var(--primary,#818cf8);background:rgba(99,102,241,.12)}',
            '.ag-meme-tabs{display:flex;align-items:center;gap:4px;padding:8px 10px 4px;overflow-x:auto;flex-shrink:0;scrollbar-width:none}',
            '.ag-meme-tab{padding:3px 9px;border-radius:999px;border:none;background:transparent;color:var(--muted-foreground,#a1a1aa);font-size:11.5px;cursor:pointer;white-space:nowrap;transition:background .12s,color .12s}',
            '.ag-meme-tab:hover{background:var(--secondary,rgba(128,128,128,.14));color:var(--foreground,inherit)}',
            '.ag-meme-tab[data-active="true"]{background:var(--primary,#6366f1);color:var(--primary-foreground,#fff);font-weight:500}',
            '.ag-meme-search-wrap{padding:4px 10px 6px;flex-shrink:0}',
            '.ag-meme-search{width:100%;box-sizing:border-box;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--border,rgba(128,128,128,.25));background:var(--background,rgba(0,0,0,.15));color:var(--foreground,inherit);font-size:12px;outline:none}',
            '.ag-meme-search:focus{border-color:var(--primary,#6366f1)}',
            '.ag-meme-grid{flex:1;min-height:0;overflow-y:auto;padding:4px 10px 10px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;align-content:start}',
            '.ag-meme-cell{aspect-ratio:1/1;border-radius:9px;border:1px solid transparent;background:var(--secondary,rgba(128,128,128,.1));padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;transition:transform .12s,border-color .12s,background .12s}',
            '.ag-meme-cell:hover{transform:translateY(-1px);border-color:var(--primary,#6366f1);background:var(--secondary,rgba(128,128,128,.2))}',
            '.ag-meme-cell img{width:100%;height:100%;object-fit:contain;border-radius:6px;pointer-events:none;display:block}',
            '.ag-meme-foot{padding:6px 12px;border-top:1px solid var(--border,rgba(128,128,128,.18));font-size:11px;color:var(--muted-foreground,#a1a1aa);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;min-height:28px}',
            '.ag-meme-foot-cap{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--foreground,inherit)}',
            '.ag-meme-import{padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;overflow-y:auto}',
            '.ag-meme-import-preview{width:100%;height:140px;border-radius:10px;background:var(--background,rgba(0,0,0,.2));display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px dashed var(--border,rgba(128,128,128,.3))}',
            '.ag-meme-import-preview img{max-width:100%;max-height:100%;object-fit:contain}',
            '.ag-meme-import label{font-size:11px;color:var(--muted-foreground,#a1a1aa);display:block;margin-bottom:3px}',
            '.ag-meme-import input,.ag-meme-import select{width:100%;box-sizing:border-box;height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--border,rgba(128,128,128,.3));background:var(--background,rgba(0,0,0,.15));color:var(--foreground,inherit);font-size:12px}',
            '.ag-meme-import-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:auto}'
        ].join("\n");
        host.appendChild(st);
    }

    function ensureZoomOverlay() {
        if (zoomBox && zoomBox.isConnected) return;
        zoomBox = document.createElement("div");
        zoomBox.setAttribute("data-ag-meme-zoom", "1");
        zoomBox.setAttribute("data-ag-localization-skip", "true");
        zoomBox.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);cursor:zoom-out;padding:28px;box-sizing:border-box";
        zoomImg = document.createElement("img");
        zoomImg.style.cssText = "max-width:100%;max-height:88vh;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.6);display:block;transition:transform .12s ease-out;transform-origin:center center";
        zoomTip = document.createElement("div");
        zoomTip.style.cssText = "position:absolute;bottom:18px;left:16px;right:16px;text-align:center;color:rgba(255,255,255,.78);font-size:12px;pointer-events:none";
        zoomBox.appendChild(zoomImg);
        zoomBox.appendChild(zoomTip);
        zoomBox.addEventListener("click", (e) => {
            if (e.target === zoomBox) closeZoom();
        });
        zoomBox.addEventListener("wheel", (e) => {
            e.preventDefault();
            zoomScale = Math.min(6, Math.max(0.4, zoomScale * (e.deltaY < 0 ? 1.15 : 0.87)));
            zoomImg.style.transform = "scale(" + zoomScale + ")";
        }, { passive: false });
        zoomBox.addEventListener("dblclick", () => {
            zoomScale = 1;
            zoomImg.style.transform = "scale(1)";
        });
        (document.body || document.documentElement).appendChild(zoomBox);
    }

    function openZoom(src, caption) {
        if (!src) return;
        ensureZoomOverlay();
        zoomImg.src = src;
        zoomImg.alt = caption || "";
        zoomTip.textContent = (caption ? caption + " · " : "") + "滚轮缩放 · 双击复位 · Esc 或点背景关闭";
        zoomScale = 1;
        zoomImg.style.transform = "scale(1)";
        zoomBox.style.display = "flex";
    }

    function closeZoom() {
        if (!zoomBox) return;
        zoomBox.style.display = "none";
        zoomScale = 1;
        if (zoomImg) zoomImg.style.transform = "scale(1)";
    }

    function teardownMemeGroup(group) {
        if (!group) return;
        if (Array.isArray(group.spawned)) {
            for (let i = 0; i < group.spawned.length; i++) {
                const n = group.spawned[i];
                if (n && n.parentNode) n.parentNode.removeChild(n);
            }
        }
        if (Array.isArray(group.entries)) {
            for (let i = 0; i < group.entries.length; i++) {
                const ent = group.entries[i];
                if (!ent || !ent.node) continue;
                if (ent.node.isConnected && ent.node.nodeValue === ent.expected) {
                    ent.node.nodeValue = ent.orig;
                }
                if (ent.node.__agMemeGroup === group) {
                    delete ent.node.__agMemeGroup;
                }
            }
        }
    }

    function isMemeGroupValid(group, enabled) {
        if (!enabled || !group) return false;
        const entries = group.entries;
        const spawned = group.spawned;
        if (!Array.isArray(entries) || entries.length === 0 || !Array.isArray(spawned) || spawned.length === 0) {
            return false;
        }
        for (let i = 0; i < entries.length; i++) {
            const ent = entries[i];
            if (!ent || !ent.node || !ent.node.isConnected || ent.node.nodeValue !== ent.expected) {
                return false;
            }
        }
        for (let i = 0; i < spawned.length; i++) {
            const s = spawned[i];
            if (!s || !s.isConnected) return false;
        }
        return true;
    }

    function buildMemeSlot(rawMarker, desc, slotMode) {
        const wrap = document.createElement("span");
        wrap.className = "ag-meme-slot";
        wrap.setAttribute("data-ag-meme-slot", "1");
        wrap.setAttribute("data-ag-localization-skip", "true");
        if (slotMode === "multi") wrap.setAttribute("data-ag-meme-multi", "1");
        else if (slotMode === "standalone" || slotMode === true) wrap.setAttribute("data-ag-meme-standalone", "1");

        const meme = resolveMeme(desc);
        const renderFallback = () => {
            if (!wrap.isConnected && imgParentCheckNeeded()) return;
            wrap.innerHTML = "";
            const fb = document.createElement("span");
            fb.className = "ag-meme-fallback";
            fb.textContent = "🐱 " + desc;
            wrap.appendChild(fb);
        };
        function imgParentCheckNeeded() {
            return wrap.parentNode == null;
        }
        if (meme) {
            const img = document.createElement("img");
            img.className = "ag-meme-img";
            img.setAttribute("data-ag-meme-img", "1");
            img.setAttribute("data-ag-meme-caption", meme.caption || desc);
            img.alt = rawMarker;
            img.title = (meme.caption || desc) + "（点击放大）";
            img.loading = "lazy";
            img.decoding = "async";
            wrap.appendChild(img);
            getMemeImageAsset(meme).then((asset) => {
                if (!img.isConnected && img.parentNode !== wrap) return;
                if (!asset || !asset.blobUrl) {
                    renderFallback();
                    return;
                }
                let triedData = false;
                img.onerror = () => {
                    if (!triedData && typeof asset.getDataUrl === "function") {
                        const dUrl = asset.getDataUrl();
                        if (dUrl && img.src !== dUrl) {
                            triedData = true;
                            img.src = dUrl;
                            return;
                        }
                    }
                    renderFallback();
                };
                img.src = asset.blobUrl;
            });
        } else {
            const fb = document.createElement("span");
            fb.className = "ag-meme-fallback";
            fb.textContent = "🐱 " + desc;
            wrap.appendChild(fb);
        }
        return wrap;
    }

    function collectBubbleInlineRuns(bubble) {
        const runs = [];
        let currentNodes = [];
        let currentBlock = bubble;
        let inlineBlockedLeft = false;

        function flush(nextInlineBlocked) {
            if (currentNodes.length > 0) {
                runs.push({
                    blockEl: currentBlock,
                    nodes: currentNodes,
                    inlineBlockedLeft: inlineBlockedLeft,
                    inlineBlockedRight: Boolean(nextInlineBlocked)
                });
                currentNodes = [];
            }
            inlineBlockedLeft = Boolean(nextInlineBlocked);
        }

        function walk(node, blockEl) {
            const children = node.childNodes;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 3) {
                    if (child.__agMemeSynthetic || child.__agMemeGroup) {
                        flush(false);
                        continue;
                    }
                    if (!currentNodes.length) currentBlock = blockEl;
                    currentNodes.push(child);
                } else if (child.nodeType === 1) {
                    if (child.matches && child.matches(SKIP_ANCESTOR_SEL)) {
                        const isMemeSlot = child.hasAttribute && child.hasAttribute("data-ag-meme-slot");
                        const isBlockSkip = BLOCK_BREAK_TAGS.has(child.tagName);
                        flush(!isMemeSlot && !isBlockSkip);
                        if (isBlockSkip) inlineBlockedLeft = false;
                        continue;
                    }
                    if (child !== bubble && child.matches && child.matches(BUBBLE_SEL)) {
                        const isBlockBubble = BLOCK_BREAK_TAGS.has(child.tagName);
                        flush(!isBlockBubble);
                        if (isBlockBubble) inlineBlockedLeft = false;
                        continue;
                    }
                    if (BLOCK_BREAK_TAGS.has(child.tagName)) {
                        flush(false);
                        inlineBlockedLeft = false;
                        walk(child, child.tagName === "BR" ? blockEl : child);
                        flush(false);
                        inlineBlockedLeft = false;
                    } else {
                        walk(child, blockEl);
                    }
                }
            }
        }

        walk(bubble, bubble);
        flush(false);
        return runs;
    }

    function buildSegmentPieces(segs, matches) {
        const result = new Array(segs.length);
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const a = seg.start;
            const b = seg.end;
            const pieces = [];
            let pos = a;
            let touched = false;
            for (let mi = 0; mi < matches.length; mi++) {
                const m = matches[mi];
                const mStart = m.index;
                const mEnd = mStart + m[0].length;
                if (mEnd <= a) continue;
                if (mStart >= b) break;
                touched = true;
                if (mStart > pos) {
                    pieces.push({ type: "text", val: seg.orig.slice(pos - a, mStart - a) });
                }
                if (mStart >= a && mStart < b) {
                    pieces.push({ type: "slot", raw: m[0], desc: m[1] });
                }
                pos = mEnd < b ? mEnd : b;
            }
            if (pos < b) {
                pieces.push({ type: "text", val: seg.orig.slice(pos - a) });
            }
            result[i] = { touched, pieces };
        }
        return result;
    }

    function applyMatchesToInlineRun(run, fullText, matches, bubble) {
        const nodes = run.nodes;
        const segs = [];
        let cursor = 0;
        for (let i = 0; i < nodes.length; i++) {
            const orig = nodes[i].nodeValue || "";
            segs.push({ node: nodes[i], orig, start: cursor, end: cursor + orig.length });
            cursor += orig.length;
        }

        const stripped = fullText.replace(MEME_RE, "").trim();
        const blockEl = run.blockEl || bubble;
        const isMsgBlock = Boolean(blockEl && (
            blockEl.tagName === "P" ||
            (blockEl.hasAttribute && (blockEl.hasAttribute("data-quotable") || blockEl.hasAttribute("data-markdown-root"))) ||
            (blockEl.getAttribute && (
                blockEl.getAttribute("data-testid") === "user-message-content" ||
                blockEl.getAttribute("data-testid") === "user-message-bubble"
            )) ||
            (blockEl.closest && blockEl.closest('[data-testid="user-message-content"], [data-testid="user-message-bubble"]'))
        ));
        const isStandalone = stripped.length === 0 && isMsgBlock && !run.inlineBlockedLeft && !run.inlineBlockedRight;
        let slotMode = "inline";
        if (isStandalone) {
            let hasSiblingSlot = matches.length > 1;
            let prev = nodes[0] && nodes[0].previousSibling;
            while (prev) {
                if (prev.nodeType === 3) {
                    if ((prev.nodeValue || "").trim()) break;
                    prev = prev.previousSibling;
                    continue;
                }
                if (prev.nodeType === 1 && prev.hasAttribute && prev.hasAttribute("data-ag-meme-slot")) {
                    hasSiblingSlot = true;
                    if (prev.hasAttribute("data-ag-meme-standalone")) {
                        prev.removeAttribute("data-ag-meme-standalone");
                        prev.setAttribute("data-ag-meme-multi", "1");
                    }
                }
                break;
            }
            slotMode = hasSiblingSlot ? "multi" : "standalone";
        }

        const mapped = buildSegmentPieces(segs, matches);
        const group = { entries: [], spawned: [] };

        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const info = mapped[i];
            if (!info.touched) continue;

            const parent = seg.node.parentNode;
            if (!parent) continue;

            const pieces = info.pieces;
            const hasSlot = pieces.some((p) => p.type === "slot");
            if (!hasSlot) {
                const nextText = pieces.map((p) => p.val).join("");
                if (seg.node.nodeValue !== nextText) seg.node.nodeValue = nextText;
                seg.node.__agMemeGroup = group;
                group.entries.push({ node: seg.node, orig: seg.orig, expected: nextText });
                continue;
            }

            let headText = "";
            let startIdx = 0;
            if (pieces.length > 0 && pieces[0].type === "text") {
                headText = pieces[0].val;
                startIdx = 1;
            }
            if (seg.node.nodeValue !== headText) seg.node.nodeValue = headText;
            seg.node.__agMemeGroup = group;
            group.entries.push({ node: seg.node, orig: seg.orig, expected: headText });

            const anchorAfter = seg.node.nextSibling;
            const frag = document.createDocumentFragment();
            for (let pi = startIdx; pi < pieces.length; pi++) {
                const pc = pieces[pi];
                if (pc.type === "slot") {
                    const slot = buildMemeSlot(pc.raw, pc.desc, slotMode);
                    group.spawned.push(slot);
                    frag.appendChild(slot);
                } else if (pc.val) {
                    const syn = document.createTextNode(pc.val);
                    syn.__agMemeSynthetic = true;
                    group.spawned.push(syn);
                    frag.appendChild(syn);
                }
            }
            if (frag.childNodes.length > 0) {
                parent.insertBefore(frag, anchorAfter);
            }
        }

        if (group.entries.length > 0 || group.spawned.length > 0) {
            if (!Array.isArray(bubble.__agMemeGroups)) bubble.__agMemeGroups = [];
            bubble.__agMemeGroups.push(group);
        }
    }

    function getVisibleNonMemeTextLength(root) {
        if (!root) return 0;
        let len = 0;
        const stack = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (node.nodeType === 3) {
                const s = (node.nodeValue || "").trim();
                if (s) len += s.length;
                continue;
            }
            if (node.nodeType === 1) {
                if (node.hasAttribute && node.hasAttribute("data-ag-meme-slot")) continue;
                const tag = (node.tagName || "").toUpperCase();
                if (tag === "SVG" || tag === "STYLE" || tag === "SCRIPT") continue;
                const cls = typeof node.className === "string"
                    ? node.className
                    : (node.getAttribute ? (node.getAttribute("class") || "") : "");
                if (cls && (cls.includes("context-scope-mention") || cls.includes("google-symbols") || cls.includes("codicon"))) {
                    continue;
                }
                const children = node.childNodes;
                if (children && children.length > 0) {
                    for (let i = children.length - 1; i >= 0; i--) {
                        stack.push(children[i]);
                    }
                }
            }
        }
        return len;
    }

    function syncUserBubbleClipState(bubble, enabled) {
        if (!bubble || !bubble.getAttribute) return;
        const testId = bubble.getAttribute("data-testid");
        if (testId !== "user-message-content" && testId !== "user-message-bubble") {
            return;
        }
        const hasSlot = Boolean(enabled && bubble.querySelector && bubble.querySelector("[data-ag-meme-slot]"));
        const unclip = hasSlot && getVisibleNonMemeTextLength(bubble) <= 240;
        const setUnclip = (el, on) => {
            if (!el) return;
            if (on && el.setAttribute) el.setAttribute("data-ag-meme-unclip", "1");
            else if (!on && el.removeAttribute) el.removeAttribute("data-ag-meme-unclip");
        };
        setUnclip(bubble, unclip);
        if (testId === "user-message-content") {
            const outerBubble = bubble.closest ? bubble.closest('[data-testid="user-message-bubble"]') : null;
            if (outerBubble) {
                const outerHasSlot = Boolean(enabled && outerBubble.querySelector && outerBubble.querySelector("[data-ag-meme-slot]"));
                setUnclip(outerBubble, outerHasSlot && getVisibleNonMemeTextLength(outerBubble) <= 240);
            }
        } else if (testId === "user-message-bubble" && bubble.children) {
            for (let i = 0; i < bubble.children.length; i++) {
                const ch = bubble.children[i];
                if (!ch || ch.nodeType !== 1 || ch.tagName !== "DIV") continue;
                if (ch.matches && ch.matches(BUBBLE_SEL)) continue;
                const chHasSlot = Boolean(enabled && ch.querySelector && ch.querySelector("[data-ag-meme-slot]"));
                setUnclip(ch, Boolean(unclip && chHasSlot));
            }
        }
    }

    function syncBubbleMemes() {
        const cfg = getActiveMemeConfig();
        const enabled = cfg.enabled !== false;
        const stickerSize = cfg.stickerSize || 168;
        if (document.documentElement) {
            document.documentElement.style.setProperty("--ag-meme-size", stickerSize + "px");
        }
        if (!enabled) closeZoom();

        const bubbles = document.querySelectorAll(BUBBLE_SEL);
        for (let bi = 0; bi < bubbles.length; bi++) {
            const bubble = bubbles[bi];
            const skipBubble = Boolean(bubble.closest && bubble.closest(SKIP_ANCESTOR_SEL));
            if (Array.isArray(bubble.__agMemeGroups) && bubble.__agMemeGroups.length > 0) {
                const kept = [];
                for (let gi = 0; gi < bubble.__agMemeGroups.length; gi++) {
                    const grp = bubble.__agMemeGroups[gi];
                    if (!skipBubble && isMemeGroupValid(grp, enabled)) {
                        kept.push(grp);
                    } else {
                        teardownMemeGroup(grp);
                    }
                }
                bubble.__agMemeGroups = kept;
            }
            if (!enabled || skipBubble) {
                syncUserBubbleClipState(bubble, false);
                continue;
            }

            const runs = collectBubbleInlineRuns(bubble);
            for (let ri = 0; ri < runs.length; ri++) {
                const run = runs[ri];
                let fullText = "";
                for (let ni = 0; ni < run.nodes.length; ni++) {
                    fullText += run.nodes[ni].nodeValue || "";
                }
                if (!MEME_TEST_RE.test(fullText)) continue;

                if (!libState) {
                    ensureLibrary(false);
                    continue;
                }

                MEME_RE.lastIndex = 0;
                const matches = [];
                let m;
                while ((m = MEME_RE.exec(fullText))) matches.push(m);
                if (matches.length > 0) {
                    applyMatchesToInlineRun(run, fullText, matches, bubble);
                }
            }
            syncUserBubbleClipState(bubble, true);
        }
        if (!enabled && document.querySelectorAll) {
            const leftovers = document.querySelectorAll("[data-ag-meme-unclip]");
            for (let li = 0; li < leftovers.length; li++) {
                leftovers[li].removeAttribute("data-ag-meme-unclip");
            }
        }
    }

    function insertMemeIntoComposer(composer, meme, forceSend) {
        if (!composer || !meme) return;
        const caption = String(meme.caption || meme.keywords || meme.file_name || "表情包").slice(0, 80);
        const marker = "[表情: " + caption + "]";
        const editor = composer.querySelector('[data-lexical-editor="true"], [contenteditable="true"]');
        if (!editor) return;

        closeBoard();
        editor.focus();

        window.requestAnimationFrame(() => {
            editor.focus();
            try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                if (sel) {
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            } catch (e) {}

            const curTrim = (editor.textContent || "").trim();
            const payload = curTrim ? ("\n" + marker) : marker;
            const before = editor.textContent || "";

            let inserted = false;
            try {
                inserted = document.execCommand("insertText", false, payload);
            } catch (e) {
                inserted = false;
            }
            if (!inserted || (editor.textContent || "") === before) {
                try {
                    const dt = new DataTransfer();
                    dt.setData("text/plain", payload);
                    editor.dispatchEvent(new ClipboardEvent("paste", {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: dt
                    }));
                } catch (e) {}
            }

            const shouldSend = typeof forceSend === "boolean"
                ? forceSend
                : (!libState || !libState.config || libState.config.pickerSendOnClick !== false);
            if (shouldSend) {
                window.setTimeout(() => {
                    const sendBtn = composer.querySelector('[data-testid="send-button"]') ||
                        composer.querySelector("button.agy-send-button");
                    if (sendBtn && !sendBtn.disabled) {
                        sendBtn.click();
                        return;
                    }
                    try {
                        editor.dispatchEvent(new KeyboardEvent("keydown", {
                            key: "Enter",
                            code: "Enter",
                            keyCode: 13,
                            which: 13,
                            bubbles: true,
                            cancelable: true
                        }));
                    } catch (e) {}
                }, 90);
            }
        });
    }

    function filterBoardMemes() {
        const all = libState && Array.isArray(libState.memes) ? libState.memes : [];
        const mood = boardState.mood || "all";
        const q = String(boardState.query || "").trim().toLowerCase();
        const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
        return all.filter((m) => {
            if (mood !== "all" && String(m.tag || "").toLowerCase() !== mood) return false;
            if (tokens.length === 0) return true;
            const hay = (m.caption + " " + m.keywords + " " + m.file_name + " " + m.tag).toLowerCase();
            return tokens.every((t) => hay.includes(t));
        });
    }

    function positionBoard(anchorBtn) {
        if (!boardEl || !anchorBtn) return;
        const rect = anchorBtn.getBoundingClientRect();
        const bw = 388;
        const bh = 452;
        let left = rect.right - bw;
        if (left < 12) left = Math.max(12, rect.left);
        if (left + bw > window.innerWidth - 12) left = Math.max(12, window.innerWidth - bw - 12);
        let top = rect.top - bh - 10;
        if (top < 12) top = Math.min(window.innerHeight - bh - 12, rect.bottom + 8);
        boardEl.style.left = Math.round(left) + "px";
        boardEl.style.top = Math.round(top) + "px";
    }

    function renderBoard() {
        if (!boardEl) return;
        boardEl.innerHTML = "";

        const cfg = (libState && libState.config) || { pickerSendOnClick: true };
        const sendOnClick = cfg.pickerSendOnClick !== false;
        const totalCount = libState && Array.isArray(libState.memes) ? libState.memes.length : 0;

        const head = document.createElement("div");
        head.className = "ag-meme-head";

        const headLeft = document.createElement("div");
        headLeft.className = "ag-meme-head-left";
        const title = document.createElement("span");
        title.className = "ag-meme-title";
        title.textContent = "Gemini 猫娘表情";
        const badge = document.createElement("span");
        badge.className = "ag-meme-count";
        badge.textContent = totalCount + " 张";
        headLeft.appendChild(title);
        headLeft.appendChild(badge);

        const headActs = document.createElement("div");
        headActs.className = "ag-meme-head-acts";

        const modeBtn = document.createElement("button");
        modeBtn.type = "button";
        modeBtn.className = "ag-meme-pill-btn";
        modeBtn.setAttribute("data-on", sendOnClick ? "true" : "false");
        modeBtn.textContent = sendOnClick ? "⚡ 点图直发" : "✏️ 仅填框";
        modeBtn.title = sendOnClick ? "点击切换为：仅填入输入框（不自动发送）" : "点击切换为：点图直接发送";
        modeBtn.addEventListener("click", () => {
            const nextVal = !sendOnClick;
            invokeFn("ag-ux:meme-save-config", { pickerSendOnClick: nextVal }).then((res) => {
                if (res && res.ok && libState) {
                    libState.config = res.config;
                    renderBoard();
                    syncMemeSettingsRow();
                }
            });
        });

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "ag-meme-pill-btn";
        addBtn.textContent = "+ 添图";
        addBtn.title = "从本地导入新表情到 Gemini 猫娘图库";
        addBtn.addEventListener("click", () => {
            invokeFn("ag-ux:meme-pick-file").then((res) => {
                if (!res || !res.ok || res.canceled || !res.filePath) return;
                const bytes = res.data instanceof Uint8Array
                    ? res.data
                    : (ArrayBuffer.isView(res.data)
                        ? new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength)
                        : new Uint8Array(res.data));
                const previewUrl = URL.createObjectURL(new Blob([bytes], { type: res.mime || "image/png" }));
                boardState.importDraft = {
                    srcPath: res.filePath,
                    previewUrl,
                    caption: res.suggestedCaption || "",
                    tag: boardState.mood !== "all" ? boardState.mood : "daily",
                    keywords: res.suggestedCaption || ""
                };
                renderBoard();
            });
        });

        const dirBtn = document.createElement("button");
        dirBtn.type = "button";
        dirBtn.className = "ag-meme-pill-btn";
        dirBtn.textContent = "📁";
        dirBtn.title = "在 Finder 中打开 ~/.gemini/meme-packs 目录";
        dirBtn.addEventListener("click", () => invokeFn("ag-ux:meme-open-pack-dir"));

        headActs.appendChild(modeBtn);
        headActs.appendChild(addBtn);
        headActs.appendChild(dirBtn);
        head.appendChild(headLeft);
        head.appendChild(headActs);
        boardEl.appendChild(head);

        if (boardState.importDraft) {
            const draft = boardState.importDraft;
            const form = document.createElement("div");
            form.className = "ag-meme-import";

            const pv = document.createElement("div");
            pv.className = "ag-meme-import-preview";
            const pvImg = document.createElement("img");
            pvImg.src = draft.previewUrl;
            pv.appendChild(pvImg);
            form.appendChild(pv);

            const mkField = (labelText, value, placeholder, onChange) => {
                const wrap = document.createElement("div");
                const lbl = document.createElement("label");
                lbl.textContent = labelText;
                const inp = document.createElement("input");
                inp.type = "text";
                inp.value = value;
                inp.placeholder = placeholder;
                inp.addEventListener("input", () => onChange(inp.value));
                wrap.appendChild(lbl);
                wrap.appendChild(inp);
                return wrap;
            };

            form.appendChild(mkField("表情描述（[表情: ...] 匹配原文）", draft.caption, "例如：吉米启动！", (v) => { draft.caption = v; }));

            const moodWrap = document.createElement("div");
            const moodLbl = document.createElement("label");
            moodLbl.textContent = "情绪分类";
            const sel = document.createElement("select");
            MOOD_TABS.filter((t) => t.id !== "all").forEach((t) => {
                const opt = document.createElement("option");
                opt.value = t.id;
                opt.textContent = t.label + " (" + t.id + ")";
                if (draft.tag === t.id) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener("change", () => { draft.tag = sel.value; });
            moodWrap.appendChild(moodLbl);
            moodWrap.appendChild(sel);
            form.appendChild(moodWrap);

            form.appendChild(mkField("检索关键词（空格分隔）", draft.keywords, "例如：探头 好奇 卖萌 猫娘", (v) => { draft.keywords = v; }));

            const acts = document.createElement("div");
            acts.className = "ag-meme-import-acts";
            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "ag-meme-pill-btn";
            cancelBtn.textContent = "取消";
            cancelBtn.addEventListener("click", () => {
                boardState.importDraft = null;
                renderBoard();
            });
            const saveBtn = document.createElement("button");
            saveBtn.type = "button";
            saveBtn.className = "ag-meme-pill-btn";
            saveBtn.setAttribute("data-on", "true");
            saveBtn.textContent = "确认收录";
            saveBtn.addEventListener("click", () => {
                if (!draft.caption.trim()) return;
                saveBtn.disabled = true;
                saveBtn.textContent = "保存中...";
                invokeFn("ag-ux:meme-import-commit", {
                    srcPath: draft.srcPath,
                    caption: draft.caption.trim(),
                    tag: draft.tag,
                    keywords: draft.keywords.trim(),
                    packId: "gemini-neko"
                }).then((res) => {
                    boardState.importDraft = null;
                    if (res && res.ok) {
                        ensureLibrary(true).then(() => renderBoard());
                    } else {
                        renderBoard();
                    }
                });
            });
            acts.appendChild(cancelBtn);
            acts.appendChild(saveBtn);
            form.appendChild(acts);
            boardEl.appendChild(form);
            return;
        }

        const tabs = document.createElement("div");
        tabs.className = "ag-meme-tabs";
        for (let i = 0; i < MOOD_TABS.length; i++) {
            const tab = MOOD_TABS[i];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ag-meme-tab";
            btn.textContent = tab.label;
            if (boardState.mood === tab.id) btn.setAttribute("data-active", "true");
            btn.addEventListener("click", () => {
                boardState.mood = tab.id;
                renderBoard();
            });
            tabs.appendChild(btn);
        }
        boardEl.appendChild(tabs);

        const searchWrap = document.createElement("div");
        searchWrap.className = "ag-meme-search-wrap";
        const searchInp = document.createElement("input");
        searchInp.type = "text";
        searchInp.className = "ag-meme-search";
        searchInp.placeholder = "搜索描述或关键词（如：爱心眼、哈气、咖啡、哭）...";
        searchInp.value = boardState.query;
        searchInp.addEventListener("input", () => {
            boardState.query = searchInp.value;
            renderGridOnly();
        });
        searchWrap.appendChild(searchInp);
        boardEl.appendChild(searchWrap);

        const grid = document.createElement("div");
        grid.className = "ag-meme-grid";
        boardEl.appendChild(grid);

        const foot = document.createElement("div");
        foot.className = "ag-meme-foot";
        const footCap = document.createElement("span");
        footCap.className = "ag-meme-foot-cap";
        footCap.textContent = sendOnClick ? "点击贴纸立即发送 · 按住 Shift 点击仅填入框内" : "点击贴纸插入输入框 · 按住 Shift 点击立即发送";
        foot.appendChild(footCap);
        boardEl.appendChild(foot);

        function renderGridOnly() {
            grid.innerHTML = "";
            const rows = filterBoardMemes();
            if (!libState) {
                const msg = document.createElement("div");
                msg.style.cssText = "grid-column:1/-1;text-align:center;padding:36px 12px;font-size:12px;color:var(--muted-foreground)";
                msg.textContent = "正在加载 Gemini 猫娘表情库...";
                grid.appendChild(msg);
                return;
            }
            if (rows.length === 0) {
                const msg = document.createElement("div");
                msg.style.cssText = "grid-column:1/-1;text-align:center;padding:36px 12px;font-size:12px;color:var(--muted-foreground)";
                msg.textContent = "没有找到匹配的猫娘表情，点右上角 + 添图可导入自定义图片";
                grid.appendChild(msg);
                return;
            }
            for (let i = 0; i < rows.length; i++) {
                const item = rows[i];
                const cell = document.createElement("button");
                cell.type = "button";
                cell.className = "ag-meme-cell";
                cell.title = item.caption + (item.keywords ? " (" + item.keywords + ")" : "");
                const img = document.createElement("img");
                img.alt = item.caption;
                img.loading = "lazy";
                cell.appendChild(img);
                getMemeImageAsset(item).then((asset) => {
                    if (!asset || !asset.blobUrl || !img.isConnected) return;
                    let triedData = false;
                    img.onerror = () => {
                        if (!triedData && typeof asset.getDataUrl === "function") {
                            const dUrl = asset.getDataUrl();
                            if (dUrl && img.src !== dUrl) {
                                triedData = true;
                                img.src = dUrl;
                            }
                        }
                    };
                    img.src = asset.blobUrl;
                });
                cell.addEventListener("mouseenter", () => {
                    footCap.textContent = "[" + item.tag + "] " + item.caption;
                });
                cell.addEventListener("mouseleave", () => {
                    footCap.textContent = sendOnClick ? "点击贴纸立即发送 · 按住 Shift 点击仅填入" : "点击贴纸插入输入框 · 按住 Shift 点击直发";
                });
                cell.addEventListener("click", (e) => {
                    const forceSend = e.shiftKey ? !sendOnClick : sendOnClick;
                    insertMemeIntoComposer(activeComposer, item, forceSend);
                });
                grid.appendChild(cell);
            }
        }

        renderGridOnly();
        window.requestAnimationFrame(() => {
            if (searchInp.isConnected) searchInp.focus();
        });
    }

    function openBoard(composer, triggerBtn) {
        ensureMemeStyle();
        activeComposer = composer;
        if (!boardEl || !boardEl.isConnected) {
            boardEl = document.createElement("div");
            boardEl.className = "ag-meme-board";
            boardEl.setAttribute("data-ag-meme-board", "1");
            boardEl.setAttribute("data-ag-localization-skip", "true");
            (document.body || document.documentElement).appendChild(boardEl);
        }
        boardOpen = true;
        if (triggerBtn) triggerBtn.setAttribute("data-active", "true");
        boardEl.style.display = "flex";
        positionBoard(triggerBtn);
        ensureLibrary(false).then(() => {
            if (boardOpen) renderBoard();
        });
        renderBoard();
    }

    function closeBoard() {
        boardOpen = false;
        boardState.importDraft = null;
        if (boardEl) boardEl.style.display = "none";
        const activeBtns = document.querySelectorAll('[data-ag-meme-trigger="true"][data-active="true"]');
        for (let i = 0; i < activeBtns.length; i++) {
            activeBtns[i].setAttribute("data-active", "false");
        }
    }

    function mountMemeTriggers() {
        const enabled = getActiveMemeConfig().enabled !== false;
        let composers = Array.from(document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"]'));
        if (composers.length === 0) {
            const editors = document.querySelectorAll('[data-lexical-editor="true"]');
            for (let i = 0; i < editors.length; i++) {
                const box = editors[i].closest(".surface-composer, [class*='rounded-2xl']");
                if (box && !composers.includes(box)) composers.push(box);
            }
        }
        for (let i = 0; i < composers.length; i++) {
            const composer = composers[i];
            let btn = composer.querySelector('[data-ag-meme-trigger="true"]');
            if (btn) {
                btn.style.display = enabled ? "inline-flex" : "none";
                continue;
            }
            if (!enabled) continue;

            const anchorBtn = composer.querySelector(
                '[data-testid="send-button"], [data-testid="send-button-pending"], [data-testid="input-cancel-button"], [data-tooltip-id="input-send-button-record-tooltip"], button.agy-send-button'
            );
            if (!anchorBtn) continue;

            let insertBeforeNode = anchorBtn;
            const p = anchorBtn.parentElement;
            if (p && p.tagName === "DIV" && p.childElementCount === 1 && p.parentElement && p.parentElement !== composer &&
                !(p.parentElement.classList && p.parentElement.classList.contains("agy-composer-footer"))) {
                insertBeforeNode = p;
            }
            const bar = insertBeforeNode.parentElement;
            if (!bar) continue;

            btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ag-meme-trigger";
            btn.setAttribute("data-ag-meme-trigger", "true");
            btn.setAttribute("data-ag-localization-skip", "true");
            btn.setAttribute("data-active", "false");
            btn.setAttribute("aria-label", "Gemini 猫娘表情包");
            btn.title = "Gemini 猫娘表情包 (⌘⇧M)";
            btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10V5.5L8.5 8.2A7.5 7.5 0 0 1 12 7.5c1.25 0 2.43.28 3.5.7L19 5.5V10c.65 1.05 1 2.28 1 3.6 0 3.98-3.58 6.9-8 6.9s-8-2.92-8-6.9c0-1.32.35-2.55 1-3.6Z"/><circle cx="9.2" cy="13.2" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="13.2" r="1" fill="currentColor" stroke="none"/><path d="M10.2 16c.5.55 1.2.7 1.8.2.6.5 1.3.35 1.8-.2"/></svg>';

            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (boardOpen && activeComposer === composer) closeBoard();
                else openBoard(composer, btn);
            });
            bar.insertBefore(btn, insertBeforeNode);
        }
    }

    function syncMemeSettingsRow() {
        const cfg = getActiveMemeConfig();
        const headings = document.querySelectorAll("h3");
        let primaryMatch = null;
        let fallbackMatch = null;
        for (let i = 0; i < headings.length; i++) {
            const h3 = headings[i];
            if (h3.childElementCount > 0) continue;
            const title = (h3.textContent || "").trim();
            const isPrimary = title === "聊天宽度" || title === "Chat Width";
            const isFallback = title === "聊天" || title === "Chat" || title === "外观" || title === "Appearance";
            if (!isPrimary && !isFallback) continue;
            const sectionRoot = h3.closest(".space-y-2") || (h3.parentElement && h3.parentElement.parentElement && h3.parentElement.parentElement.parentElement);
            if (!sectionRoot) continue;
            const card = sectionRoot.querySelector(".agy-card");
            if (!card) continue;
            const isEnUi = /^[A-Za-z0-9\s]+$/.test(title);
            if (isPrimary) {
                primaryMatch = { card, isEnUi };
                break;
            }
            if (!fallbackMatch) fallbackMatch = { card, isEnUi };
        }
        const matchedTarget = primaryMatch || fallbackMatch;
        if (matchedTarget) {
            const card = matchedTarget.card;
            const isEnUi = matchedTarget.isEnUi;

            let row = card.querySelector('[data-ag-ux-meme-row="true"]');
            if (!row) {
                row = document.createElement("div");
                row.setAttribute("data-ag-ux-meme-row", "true");
                row.setAttribute("data-ag-localization-skip", "true");
                row.className = "py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center";

                const leftCol = document.createElement("div");
                leftCol.className = "flex-1 flex flex-col gap-1";

                const labelWrap = document.createElement("div");
                labelWrap.className = "flex items-center gap-1.5";
                const labelEl = document.createElement("span");
                labelEl.className = "text-sm";
                labelEl.id = "ag-ux-meme-label";
                labelEl.textContent = isEnUi ? "Neko Meme Stickers" : "Gemini 猫娘表情包";
                const badgeEl = document.createElement("span");
                badgeEl.className = "text-[10px] font-semibold leading-none bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-full select-none border border-border";
                badgeEl.textContent = "Meme";
                labelWrap.appendChild(labelEl);
                labelWrap.appendChild(badgeEl);

                const descEl = document.createElement("span");
                descEl.className = "text-xs text-muted-foreground whitespace-pre-wrap";
                descEl.textContent = isEnUi ? "Render [表情: ...] markers in chat bubbles as Neko stickers, with an inline picker & zoom viewer." : "开启后将聊天中的 [表情: ...] 渲染为猫娘贴纸，并在输入框工具栏提供表情面板与点击放大。";

                const quickActs = document.createElement("div");
                quickActs.className = "flex items-center gap-2 pt-0.5";

                const sendModeBtn = document.createElement("button");
                sendModeBtn.type = "button";
                sendModeBtn.setAttribute("data-ag-meme-sendmode", "true");
                sendModeBtn.className = "text-[11px] px-2 py-0.5 rounded-md border border-border bg-secondary/60 hover:bg-secondary text-foreground cursor-pointer";
                sendModeBtn.addEventListener("click", () => {
                    const cur = getActiveMemeConfig().pickerSendOnClick !== false;
                    invokeFn("ag-ux:meme-save-config", { pickerSendOnClick: !cur }).then((res) => {
                        if (res && res.ok) {
                            configOverrideSeq++;
                            configOverride = res.config;
                            if (libState) libState.config = res.config;
                            syncMemeSettingsRow();
                            if (boardOpen) renderBoard();
                        }
                    });
                });

                const openDirBtn = document.createElement("button");
                openDirBtn.type = "button";
                openDirBtn.className = "text-[11px] px-2 py-0.5 rounded-md border border-border bg-transparent hover:bg-secondary text-muted-foreground hover:text-foreground cursor-pointer";
                openDirBtn.textContent = isEnUi ? "Open Packs Folder" : "打开图库文件夹";
                openDirBtn.addEventListener("click", () => invokeFn("ag-ux:meme-open-pack-dir"));

                quickActs.appendChild(sendModeBtn);
                quickActs.appendChild(openDirBtn);

                leftCol.appendChild(labelWrap);
                leftCol.appendChild(descEl);
                leftCol.appendChild(quickActs);

                const rightCol = document.createElement("div");
                rightCol.className = "shrink-0";

                const switchBtn = document.createElement("button");
                switchBtn.type = "button";
                switchBtn.setAttribute("data-ag-meme-main-switch", "true");
                switchBtn.setAttribute("role", "switch");
                switchBtn.setAttribute("aria-labelledby", "ag-ux-meme-label");
                const thumbEl = document.createElement("span");
                thumbEl.className = "inline-block rounded-full bg-white transition-transform duration-200 ease-in-out shadow-sm h-4 w-4";
                switchBtn.appendChild(thumbEl);
                switchBtn.addEventListener("click", () => {
                    const curEnabled = getActiveMemeConfig().enabled !== false;
                    invokeFn("ag-ux:meme-save-config", { enabled: !curEnabled }).then((res) => {
                        if (res && res.ok) {
                            configOverrideSeq++;
                            configOverride = res.config;
                            if (libState) libState.config = res.config;
                            if (!res.config.enabled) {
                                closeBoard();
                                closeZoom();
                            }
                            syncMemeSettingsRow();
                            syncMemes();
                        }
                    });
                });

                rightCol.appendChild(switchBtn);
                row.appendChild(leftCol);
                row.appendChild(rightCol);
                card.appendChild(row);
            }

            const enabledNow = cfg.enabled !== false;
            const sendOnClickNow = cfg.pickerSendOnClick !== false;
            const switchBtn = row.querySelector('[data-ag-meme-main-switch="true"]');
            const sendModeBtn = row.querySelector('[data-ag-meme-sendmode="true"]');
            if (switchBtn) {
                switchBtn.setAttribute("aria-checked", enabledNow ? "true" : "false");
                switchBtn.className = "relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out shrink-0 h-6 w-11 cursor-pointer " + (enabledNow ? "bg-primary" : "bg-secondary");
                const thumb = switchBtn.firstElementChild;
                if (thumb) thumb.style.transform = enabledNow ? "translateX(24px)" : "translateX(4px)";
            }
            if (sendModeBtn) {
                const nextModeText = isEnUi ? (sendOnClickNow ? "Mode: Click to Send" : "Mode: Insert Only") : (sendOnClickNow ? "点击模式：点图直发" : "点击模式：先填入输入框");
                if (sendModeBtn.textContent !== nextModeText) {
                    sendModeBtn.textContent = nextModeText;
                }
            }
        }
    }

    function syncMemes() {
        ensureMemeStyle();
        mountMemeTriggers();
        syncMemeSettingsRow();
        syncBubbleMemes();
    }

    if (!document.__agMemeListenersBound) {
        document.__agMemeListenersBound = true;
        document.addEventListener("click", (e) => {
            const t = e.target;
            if (t && t.tagName === "IMG" && t.getAttribute("data-ag-meme-img") === "1") {
                if (t.closest("button, a, [role='button']")) return;
                e.preventDefault();
                e.stopPropagation();
                openZoom(t.currentSrc || t.src, t.getAttribute("data-ag-meme-caption") || t.alt);
                return;
            }
            if (boardOpen && boardEl && t && !boardEl.contains(t) && !(t.closest && t.closest('[data-ag-meme-trigger="true"]'))) {
                closeBoard();
            }
        }, true);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                if (zoomBox && zoomBox.style.display === "flex") {
                    e.stopPropagation();
                    closeZoom();
                    return;
                }
                if (boardOpen) {
                    e.stopPropagation();
                    closeBoard();
                    return;
                }
            }
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && String(e.key || "").toLowerCase() === "m") {
                const enabled = !libState || !libState.config || libState.config.enabled !== false;
                if (!enabled) return;
                const composer = document.querySelector('[id="antigravity.agentSidePanelInputBox"]') ||
                    (document.querySelector('[data-lexical-editor="true"]') && document.querySelector('[data-lexical-editor="true"]').closest(".surface-composer, [class*='rounded-2xl']"));
                const btn = composer && composer.querySelector('[data-ag-meme-trigger="true"]');
                if (composer && btn) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (boardOpen) closeBoard();
                    else openBoard(composer, btn);
                }
            }
        }, true);
    }

    let memeRafPending = false;
    globalThis.__agScheduleMemeSync = function() {
        if (memeRafPending) return;
        memeRafPending = true;
        window.requestAnimationFrame(() => {
            memeRafPending = false;
            try {
                syncMemes();
            } catch (e) {}
        });
    };

    if (!document.__agMemeObserverBound && typeof MutationObserver !== "undefined") {
        document.__agMemeObserverBound = true;
        const memeObs = new MutationObserver(() => {
            if (typeof globalThis.__agScheduleMemeSync === "function") {
                globalThis.__agScheduleMemeSync();
            }
        });
        const bindMemeObserver = () => {
            const root = document.body || document.documentElement;
            if (!root) return;
            try {
                memeObs.observe(root, { childList: true, subtree: true, characterData: true });
            } catch (_) {}
        };
        if (document.body || document.documentElement) {
            bindMemeObserver();
        } else {
            document.addEventListener("DOMContentLoaded", bindMemeObserver, { once: true });
        }
    }

    ensureMemeStyle();
    ensureLibrary(false);
    if (document.readyState !== "loading") {
        globalThis.__agScheduleMemeSync();
    } else {
        document.addEventListener("DOMContentLoaded", () => globalThis.__agScheduleMemeSync());
    }
}

function removeMarkedBlocks(content, startMark, endMark) {
    let cleaned = content;
    let startIdx = cleaned.indexOf(startMark);
    while (startIdx !== -1) {
        const endIdx = cleaned.indexOf(endMark, startIdx + startMark.length);
        if (endIdx === -1) break;
        cleaned = cleaned.substring(0, startIdx) + cleaned.substring(endIdx + endMark.length);
        startIdx = cleaned.indexOf(startMark);
    }
    return cleaned;
}

function getPosixTargetUid() {
    const sudoUidText = String(process.env.SUDO_UID || '');
    if (/^\d+$/.test(sudoUidText)) return Number(sudoUidText);
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function getPosixProcessTable() {
    try {
        const stdout = child_process.execFileSync(
            'ps',
            ['-eo', 'pid=,ppid=,uid=,stat=,comm=,args='],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return stdout.split(/\r?\n/).map(line => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
            if (!match) return null;
            return {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                uid: Number(match[3]),
                stat: match[4],
                comm: match[5],
                args: match[6] || ''
            };
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

function isPosixAntigravityMainProcess(entry, targetUid = getPosixTargetUid()) {
    if (targetUid !== null && entry.uid !== targetUid) return false;
    if (/(?:^|\s)--type(?:=|\s)/i.test(entry.args)) return false;

    const commBase = path.basename(entry.comm).toLowerCase();
    if (commBase === 'antigravity') return true;

    return /^\s*\/.*\/Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/i.test(entry.args);
}

function getPosixAntigravityMainProcesses(processTable = getPosixProcessTable()) {
    const targetUid = getPosixTargetUid();
    return processTable.filter(entry => isPosixAntigravityMainProcess(entry, targetUid));
}

function collectPosixProcessTreePids(processTable, rootPids) {
    const collected = new Set(rootPids);
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of processTable) {
            if (!collected.has(entry.ppid) || collected.has(entry.pid)) continue;
            collected.add(entry.pid);
            changed = true;
        }
    }
    return collected;
}

function refreshPosixProcessTree(trackedPids) {
    const processTable = getPosixProcessTable();
    const expanded = collectPosixProcessTreePids(processTable, trackedPids);
    for (const pid of expanded) trackedPids.add(pid);
    return processTable.filter(entry => {
        return trackedPids.has(entry.pid) && !entry.stat.toUpperCase().startsWith('Z');
    });
}

function sleepSync(milliseconds) {
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitArray, 0, 0, milliseconds);
}

function signalPosixProcesses(processEntries, signal) {
    for (const entry of processEntries) {
        try {
            process.kill(entry.pid, signal);
        } catch (e) {
            if (e.code !== 'ESRCH') {
                console.warn("[警告] 无法向进程 " + entry.pid + " (" + entry.comm + ") 发送 " + signal + ": " + e.message);
            }
        }
    }
}

function waitForPosixProcessTreeExit(trackedPids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let remaining = refreshPosixProcessTree(trackedPids);
    while (remaining.length > 0 && Date.now() < deadline) {
        sleepSync(100);
        remaining = refreshPosixProcessTree(trackedPids);
    }
    return remaining;
}

function checkIfAppIsRunning() {
    try {
        if (process.platform === 'win32') {
            const stdout = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return stdout.toLowerCase().includes('antigravity.exe');
        } else {
            const processTable = getPosixProcessTable();
            if (processTable.length === 0) return true;
            return getPosixAntigravityMainProcesses(processTable).length > 0;
        }
    } catch (e) {
    }
    return false;
}

function closeAntigravityProcesses() {
    console.log("[1] 检测到 Antigravity 客户端正在运行，正在等待客户端完整退出...");
    try {
        if (process.platform === 'win32') {
            child_process.execSync('taskkill /f /im Antigravity.exe /t >nul 2>nul');
            sleepSync(1500);
            return true;
        }
    } catch (e) {
        console.error("[错误] 关闭 Antigravity 失败: " + e.message);
        return false;
    }

    const platformLabel = process.platform === 'darwin' ? 'macOS' : 'Linux';
    const processTable = getPosixProcessTable();
    if (processTable.length === 0) {
        console.error(`[错误] 无法读取 ${platformLabel} 进程列表，已停止汉化以避免覆盖运行中的客户端文件。`);
        return false;
    }
    const mainProcesses = getPosixAntigravityMainProcesses(processTable);
    if (mainProcesses.length === 0) return true;

    const trackedPids = collectPosixProcessTreePids(
        processTable,
        mainProcesses.map(entry => entry.pid)
    );
    const mainPids = new Set(mainProcesses.map(entry => entry.pid));

    signalPosixProcesses(mainProcesses, 'SIGTERM');
    let remaining = waitForPosixProcessTreeExit(trackedPids, 10000);

    if (remaining.length > 0) {
        const remainingMainProcesses = remaining.filter(entry => mainPids.has(entry.pid));
        if (remainingMainProcesses.length > 0) {
            console.log("[等待] Antigravity 主进程仍在关闭，正在再次请求正常退出...");
            signalPosixProcesses(remainingMainProcesses, 'SIGTERM');
            remaining = waitForPosixProcessTreeExit(trackedPids, 5000);
        }
    }

    if (remaining.length > 0 && !remaining.some(entry => mainPids.has(entry.pid))) {
        console.log("[等待] 主程序已退出，正在关闭 " + remaining.length + " 个遗留后台进程...");
        signalPosixProcesses(remaining, 'SIGTERM');
        remaining = waitForPosixProcessTreeExit(trackedPids, 5000);
    }

    if (remaining.length > 0) {
        const summary = remaining
            .slice(0, 8)
            .map(entry => entry.pid + " (" + entry.comm + ")")
            .join(', ');
        console.error("[错误] Antigravity 未能完整退出，已停止汉化以保护正在运行的客户端。");
        console.error("[错误] 仍在运行: " + summary + (remaining.length > 8 ? ' ...' : ''));
        console.error("[提示] 请确认客户端和相关后台任务已结束后重新运行安装脚本。");
        return false;
    }

    console.log("[√] Antigravity 主程序及后台进程已完整退出。");
    return true;
}

function detectInstallationDir(manualDir, options = {}) {
    const quiet = Boolean(options && options.quiet);
    const hasAntigravityResources = (candidate) => {
        return fs.existsSync(path.join(candidate, "resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "resources", "app.asar.bak")) ||
            fs.existsSync(path.join(candidate, "app.asar")) ||
            fs.existsSync(path.join(candidate, "app.asar.bak")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar.bak")) ||
            fs.existsSync(path.join(candidate, "resources", "app", "product.json"));
    };

    if (manualDir) {
        if (fs.existsSync(manualDir)) {
            let resolved = path.resolve(manualDir);
            if (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) {
                resolved = path.dirname(resolved);
            }
            if (!hasAntigravityResources(resolved) && fs.statSync(resolved).isDirectory()) {
                try {
                    const subItems = fs.readdirSync(resolved);
                    for (const sub of subItems) {
                        const subPath = path.join(resolved, sub);
                        if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory() && hasAntigravityResources(subPath)) {
                            return path.resolve(subPath);
                        }
                    }
                } catch (e) {}
            }
            return resolved;
        } else {
            if (quiet) return null;
            console.error(`[错误] 手动指定的路径不存在: ${manualDir}`);
            process.exit(1);
        }
    }

    const candidates = [];
    const seenCandidates = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (!seenCandidates.has(key)) {
            candidates.push(normalized);
            seenCandidates.add(key);
        }
    };

    addCandidate(process.env.ANTIGRAVITY_INSTALL_DIR);
    addCandidate(process.env.ANTIGRAVITY_HOME);

    if (process.platform === 'win32') {
        const registryRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const root of registryRoots) {
            try {
                const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe' });
                for (const line of output.split(/\r?\n/)) {
                    const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                    if (!match) continue;
                    let value = match[2].trim().replace(/^"|"$/g, '');
                    if (/Antigravity\.exe/i.test(value)) {
                        value = path.dirname(value);
                    }
                    addCandidate(value);
                }
            } catch (e) {
            }
        }
        const driveLetters = ['C', 'D', 'E', 'F'];
        for (const drive of driveLetters) {
            addCandidate(`${drive}:\\Programs\\Antigravity`);
            addCandidate(`${drive}:\\Antigravity`);
        }
        addCandidate("C:\\Program Files\\Antigravity");
        addCandidate("C:\\Program Files (x86)\\Antigravity");
        const localAppdata = process.env.LOCALAPPDATA;
        if (localAppdata) {
            addCandidate(path.join(localAppdata, 'antigravity'));
            addCandidate(path.join(localAppdata, 'Programs', 'antigravity'));
        }
    } else if (process.platform === 'darwin') {
        const homeDirs = [];
        if (process.env.HOME) homeDirs.push(process.env.HOME);
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
            const sudoHome = path.join('/Users', process.env.SUDO_USER);
            if (fs.existsSync(sudoHome) && !homeDirs.includes(sudoHome)) {
                homeDirs.push(sudoHome);
            }
        }
        addCandidate('/Applications/Antigravity.app');
        for (const h of homeDirs) {
            addCandidate(path.join(h, 'Applications', 'Antigravity.app'));
        }
        try {
            const mdfindOut = child_process.execSync('mdfind "kMDItemFSName == \'Antigravity.app\'" 2>/dev/null', { encoding: 'utf-8' });
            for (const line of mdfindOut.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.includes('/.Trash') && !trimmed.includes('/.Trashes') && !trimmed.startsWith('/Volumes/')) {
                    addCandidate(trimmed);
                }
            }
        } catch (e) {}
    } else {
        const homeDirs = [];
        if (process.env.HOME) homeDirs.push(process.env.HOME);
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
            let sudoHome = '';
            try {
                const getent = child_process.execSync(`getent passwd "${process.env.SUDO_USER}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
                if (getent) {
                    const parts = getent.split(':');
                    if (parts.length >= 6 && parts[5]) {
                        sudoHome = parts[5];
                    }
                }
            } catch (e) {}
            if (!sudoHome) {
                sudoHome = path.join('/home', process.env.SUDO_USER);
            }
            if (fs.existsSync(sudoHome) && !homeDirs.includes(sudoHome)) {
                homeDirs.push(sudoHome);
            }
        }

        const isRunningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

        const addHomeCandidates = () => {
            for (const homeDir of homeDirs) {
                addCandidate(path.join(homeDir, '.local', 'share', 'antigravity'));
                addCandidate(path.join(homeDir, '.local', 'share', 'Antigravity'));
                addCandidate(path.join(homeDir, 'antigravity'));
                addCandidate(path.join(homeDir, 'Antigravity'));
                addCandidate(path.join(homeDir, '.local', 'share', 'flatpak', 'app', 'com.antigravity', 'current', 'active', 'files', 'share', 'antigravity'));
            }
            for (const homeDir of homeDirs) {
                const userDesktopFiles = [
                    path.join(homeDir, '.local', 'share', 'applications', 'antigravity.desktop'),
                    path.join(homeDir, '.local', 'share', 'applications', 'Antigravity.desktop')
                ];
                for (const df of userDesktopFiles) {
                    if (fs.existsSync(df)) {
                        try {
                            const content = fs.readFileSync(df, 'utf-8');
                            const execMatch = content.match(/^Exec=(.*)$/m);
                            if (execMatch && execMatch[1]) {
                                let execPath = execMatch[1].trim().split(/\s+/)[0].replace(/^"|"$/g, '');
                                if (fs.existsSync(execPath)) {
                                    try { execPath = fs.realpathSync(execPath); } catch (e) {}
                                    addCandidate(path.dirname(execPath));
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        };

        const addSystemCandidates = () => {
            try {
                const whichOut = child_process.execSync(
                    'command -v antigravity 2>/dev/null || which antigravity 2>/dev/null || command -v agy 2>/dev/null || which agy 2>/dev/null || command -v Antigravity 2>/dev/null || which Antigravity 2>/dev/null',
                    { encoding: 'utf-8' }
                ).trim();
                if (whichOut && fs.existsSync(whichOut)) {
                    let realP = whichOut;
                    try { realP = fs.realpathSync(whichOut); } catch (e) {}
                    addCandidate(path.dirname(realP));
                    try {
                        const fileContent = fs.readFileSync(realP, 'utf-8');
                        const scriptMatch = fileContent.match(/(?:\/opt|\/usr|\/home\/[^\s'"]+)\/[^\s'"]*antigravity[^\s'"]*/i);
                        if (scriptMatch && fs.existsSync(scriptMatch[0])) {
                            let target = scriptMatch[0];
                            try { target = fs.realpathSync(target); } catch (e) {}
                            addCandidate(fs.statSync(target).isDirectory() ? target : path.dirname(target));
                        }
                    } catch (e) {}
                }
            } catch (e) {}

            const desktopFiles = [
                '/usr/share/applications/antigravity.desktop',
                '/usr/share/applications/Antigravity.desktop',
                '/usr/local/share/applications/antigravity.desktop',
                '/usr/local/share/applications/Antigravity.desktop'
            ];
            for (const df of desktopFiles) {
                if (fs.existsSync(df)) {
                    try {
                        const content = fs.readFileSync(df, 'utf-8');
                        const execMatch = content.match(/^Exec=(.*)$/m);
                        if (execMatch && execMatch[1]) {
                            let execPath = execMatch[1].trim().split(/\s+/)[0].replace(/^"|"$/g, '');
                            if (fs.existsSync(execPath)) {
                                try { execPath = fs.realpathSync(execPath); } catch (e) {}
                                addCandidate(path.dirname(execPath));
                            }
                        }
                    } catch (e) {}
                }
            }

            addCandidate('/opt/antigravity/Antigravity-x64');
            addCandidate('/opt/antigravity/antigravity-x64');
            addCandidate('/opt/Antigravity/Antigravity-x64');
            addCandidate('/opt/antigravity');
            addCandidate('/opt/Antigravity');
            addCandidate('/usr/local/share/antigravity');
            addCandidate('/usr/local/share/Antigravity');
            addCandidate('/usr/share/antigravity');
            addCandidate('/usr/share/Antigravity');
            addCandidate('/usr/lib/antigravity');
            addCandidate('/usr/lib/Antigravity');
            addCandidate('/snap/antigravity/current');
            addCandidate('/snap/antigravity/current/usr/share/antigravity');
            addCandidate('/var/lib/flatpak/app/com.antigravity/current/active/files/share/antigravity');
        };

        if (isRunningAsRoot) {
            addSystemCandidates();
            addHomeCandidates();
        } else {
            addHomeCandidates();
            addSystemCandidates();
        }
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            if (hasAntigravityResources(p)) {
                if (!quiet) console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${p}`);
                return path.resolve(p);
            }
            try {
                if (fs.statSync(p).isDirectory()) {
                    const subItems = fs.readdirSync(p);
                    for (const sub of subItems) {
                        const subPath = path.join(p, sub);
                        if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory() && hasAntigravityResources(subPath)) {
                            if (!quiet) console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${subPath}`);
                            return path.resolve(subPath);
                        }
                    }
                }
            } catch (e) {}
        }
    }

    if (quiet) return null;
    console.error("[错误] 未找到默认安装目录，请使用 --install-dir 手动指定您的安装路径！");
    process.exit(1);
}

function runCommandSync(cmd, args) {
    try {
        if (Array.isArray(args)) {
            const res = child_process.spawnSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe' });
            if (res.error) throw res.error;
            return {
                success: res.status === 0,
                stdout: res.stdout || '',
                stderr: res.stderr || ''
            };
        }
        const out = child_process.execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
        return { success: true, stdout: out, stderr: '' };
    } catch (e) {
        return { success: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
}

function reportWritePermissionError(resourcesDir, error, action, entryScript = 'install.sh') {
    const detail = error && (error.code || error.message);
    console.error(`\n[权限不足] 无法${action} Antigravity 安装目录: ${resourcesDir}`);
    if (detail) console.error(`[详情] ${detail}`);

    if (process.platform === 'win32') {
        console.error("[提示] 请右键安装脚本并选择“以管理员身份运行”，然后重试。");
    } else {
        console.error("[提示] 此安装位于系统目录，需要管理员权限。请完全退出客户端后，在汉化包目录运行：");
        console.error(`  sudo ./${entryScript}`);
    }
}

function findMacAppBundle(resourcesDir) {
    if (!resourcesDir) return null;
    let current = path.resolve(resourcesDir);
    while (current && current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.app') && fs.existsSync(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    return null;
}

function canWriteAntigravityResources(resourcesDir, entryScript) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) return true;

    try {
        fs.accessSync(resourcesDir, fs.constants.W_OK | fs.constants.X_OK);
        if (fs.existsSync(asarPath)) {
            fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
        }
        if (fs.existsSync(bakPath)) {
            fs.accessSync(bakPath, fs.constants.R_OK | fs.constants.W_OK);
        }
        if (process.platform === 'darwin') {
            const targetApp = findMacAppBundle(resourcesDir);
            if (targetApp) {
                fs.accessSync(targetApp, fs.constants.W_OK | fs.constants.X_OK);
            }
        }
        return true;
    } catch (e) {
        reportWritePermissionError(resourcesDir, e, '写入', entryScript);
        return false;
    }
}

function resignAppOnMac(resourcesDir) {
    if (process.platform !== 'darwin') return true;

    let targetApp = findMacAppBundle(resourcesDir);
    if (!targetApp) {
        console.warn("[警告] 未能识别到 Antigravity.app 目录结构，跳过 macOS 重签名。");
        return true;
    }
    try {
        targetApp = fs.realpathSync(targetApp);
    } catch (e) {}

    console.log(`[签名] 正在清理 macOS 隔离属性并执行自签名: ${targetApp}`);
    const xattrRes = runCommandSync('xattr', ['-cr', targetApp]);
    if (!xattrRes.success) {
        console.warn(`[警告] 清理 quarantine 属性时出现提示: ${xattrRes.stderr || xattrRes.stdout}`);
    }

    // 由内而外（Inside-Out）优先重签内部 Frameworks / Dylibs / Helpers，
    // 嵌套的 .framework 与 .app 需带上 --deep 确保其内部动态库及辅助程序完成签名，
    // 避免顶层签名时遗留旧签名导致 dyld 报签名/校验不一致。
    const frameworksDir = path.join(targetApp, 'Contents', 'Frameworks');
    if (fs.existsSync(frameworksDir)) {
        try {
            const entries = fs.readdirSync(frameworksDir);
            for (const entry of entries) {
                const fullPath = path.join(frameworksDir, entry);
                if (entry.endsWith('.framework') || entry.endsWith('.app')) {
                    const res = runCommandSync('codesign', ['--force', '--deep', '--sign', '-', fullPath]);
                    if (!res.success) {
                        console.warn(`[警告] 重签内部组件 ${entry} 出现提示: ${res.stderr || res.stdout}`);
                    }
                } else if (entry.endsWith('.dylib')) {
                    const res = runCommandSync('codesign', ['--force', '--sign', '-', fullPath]);
                    if (!res.success) {
                        console.warn(`[警告] 重签内部动态库 ${entry} 出现提示: ${res.stderr || res.stdout}`);
                    }
                }
            }
        } catch (e) {
            console.warn(`[警告] 遍历 Frameworks 目录失败: ${e.message}`);
        }
    }

    // 注意：绝不能传入 --preserve-metadata=flags,runtime！
    // 否则会保留 Hardened Runtime（硬化运行时），而硬化运行时默认强制执行 Library Validation（库校验）；
    // 在本地自签名（ad-hoc，-）缺少 Apple Team ID 的情况下，dyld 会因 Team ID 不一致在启动阶段直接终止进程闪退（SIGABRT）。
    const signRes = runCommandSync('codesign', [
        '--force',
        '--deep',
        '--sign',
        '-',
        targetApp
    ]);
    if (!signRes.success) {
        console.error(`[错误] macOS 应用签名失败。`);
        console.error(`详情: ${signRes.stderr}\n${signRes.stdout}`);
        console.error(`[提示] 请检查是否已安装 Xcode Command Line Tools (xcode-select --install)。`);
        return false;
    }

    console.log(`[√] macOS 应用自签名成功！`);
    return true;
}

class AsarArchive {
    static align4(n) {
        return (n + 3) & ~3;
    }

    static readHeader(asarPath) {
        const fd = fs.openSync(asarPath, 'r');
        try {
            const sizeBuf = Buffer.alloc(8);
            fs.readSync(fd, sizeBuf, 0, 8, 0);

            const headerSize = sizeBuf.readUInt32LE(4);
            const headerBuf = Buffer.alloc(headerSize);
            fs.readSync(fd, headerBuf, 0, headerSize, 8);

            const jsonLen = headerBuf.readUInt32LE(4);
            const jsonStr = headerBuf.slice(8, 8 + jsonLen).toString('utf8');
            const header = JSON.parse(jsonStr);
            const baseOffset = 8 + headerSize;
            return { header, baseOffset, headerSize, jsonLen };
        } finally {
            fs.closeSync(fd);
        }
    }

    static createHeaderBuffer(headerJson) {
        const jsonBuf = Buffer.from(headerJson, 'utf8');
        const jsonLen = jsonBuf.length;
        const alignedJsonLen = this.align4(jsonLen);

        const headerPayloadSize = 4 + alignedJsonLen;
        const headerBuf = Buffer.alloc(4 + headerPayloadSize);
        headerBuf.writeUInt32LE(headerPayloadSize, 0);
        headerBuf.writeUInt32LE(jsonLen, 4);
        jsonBuf.copy(headerBuf, 8);

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeUInt32LE(4, 0);
        sizeBuf.writeUInt32LE(headerBuf.length, 4);

        return Buffer.concat([sizeBuf, headerBuf]);
    }

    static readFile(sourceAsar, relPath) {
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const parts = relPath.replace(/\\/g, '/').split('/');
        let cur = header.files;
        for (const p of parts) {
            if (!cur || !cur[p]) return null;
            cur = cur[p].files ? cur[p].files : cur[p];
        }
        if (cur.unpacked) {
            const unpackedPath = path.join(`${sourceAsar}.unpacked`, ...parts);
            if (fs.existsSync(unpackedPath)) return fs.readFileSync(unpackedPath);
            return null;
        }
        if (cur.offset === undefined || cur.size === undefined) return null;
        const fd = fs.openSync(sourceAsar, 'r');
        try {
            const buf = Buffer.alloc(cur.size);
            fs.readSync(fd, buf, 0, cur.size, baseOffset + parseInt(cur.offset));
            return buf;
        } finally {
            fs.closeSync(fd);
        }
    }

    static patchArchive(sourceAsar, targetAsar, filePatches) {
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const srcFd = fs.openSync(sourceAsar, 'r');
        let destFd = null;

        try {
            const fileEntries = [];
            function walk(dir, currentPath) {
                for (const [name, entry] of Object.entries(dir)) {
                    const fullPath = currentPath ? `${currentPath}/${name}` : name;
                    if (entry.files) {
                        walk(entry.files, fullPath);
                    } else {
                        fileEntries.push({ path: fullPath, entry });
                    }
                }
            }
            walk(header.files, '');

            const existingPaths = new Set(fileEntries.map(f => f.path));
            const packedFiles = fileEntries.filter(f => !f.entry.unpacked && f.entry.offset !== undefined);
            packedFiles.sort((a, b) => parseInt(a.entry.offset) - parseInt(b.entry.offset));

            for (const item of packedFiles) {
                item.oldOffset = parseInt(item.entry.offset);
                item.oldSize = item.entry.size;
                const patch = filePatches[item.path];
                if (patch !== undefined && patch !== null) {
                    const patchBuf = Buffer.isBuffer(patch) ? patch : Buffer.from(patch, 'utf8');
                    item.patchBuffer = patchBuf;
                    item.entry.size = patchBuf.length;
                }
            }

            for (const [rawPatchPath, patch] of Object.entries(filePatches)) {
                const patchPath = rawPatchPath.replace(/\\/g, '/').replace(/^\/+/, '');
                if (!patchPath || existingPaths.has(patchPath) || patch === undefined || patch === null) continue;
                const parts = patchPath.split('/');
                let dir = header.files;
                for (let i = 0; i < parts.length - 1; i++) {
                    const seg = parts[i];
                    if (!dir[seg] || !dir[seg].files) {
                        dir[seg] = { files: {} };
                    }
                    dir = dir[seg].files;
                }
                const fileName = parts[parts.length - 1];
                const patchBuf = Buffer.isBuffer(patch) ? patch : Buffer.from(patch, 'utf8');
                const newEntry = { size: patchBuf.length, offset: '0' };
                dir[fileName] = newEntry;
                existingPaths.add(patchPath);
                packedFiles.push({
                    path: patchPath,
                    entry: newEntry,
                    oldOffset: 0,
                    oldSize: 0,
                    patchBuffer: patchBuf
                });
            }

            let currentOffset = BigInt(0);
            for (const item of packedFiles) {
                item.entry.offset = currentOffset.toString();
                currentOffset += BigInt(item.entry.size);
            }

            const newHeaderBuf = this.createHeaderBuffer(JSON.stringify(header));
            destFd = fs.openSync(targetAsar, 'w');
            fs.writeSync(destFd, newHeaderBuf, 0, newHeaderBuf.length, 0);

            let writePos = newHeaderBuf.length;
            const copyBufSize = 256 * 1024;
            const copyBuf = Buffer.alloc(copyBufSize);

            for (const item of packedFiles) {
                if (item.patchBuffer) {
                    fs.writeSync(destFd, item.patchBuffer, 0, item.patchBuffer.length, writePos);
                    writePos += item.patchBuffer.length;
                } else {
                    let remaining = item.oldSize;
                    let readPos = baseOffset + item.oldOffset;
                    while (remaining > 0) {
                        const toRead = Math.min(remaining, copyBufSize);
                        fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
                        fs.writeSync(destFd, copyBuf, 0, toRead, writePos);
                        readPos += toRead;
                        writePos += toRead;
                        remaining -= toRead;
                    }
                }
            }
        } finally {
            if (srcFd) fs.closeSync(srcFd);
            if (destFd) fs.closeSync(destFd);
        }
    }
}


function resolveResourcesDir(installDir) {
    if (fs.existsSync(path.join(installDir, "resources"))) {
        return path.join(installDir, "resources");
    }
    if (fs.existsSync(path.join(installDir, "Contents", "Resources"))) {
        return path.join(installDir, "Contents", "Resources");
    }
    if (installDir.replace(/[/\\]$/, "").toLowerCase().endsWith("resources")) {
        return installDir;
    }
    if (fs.existsSync(path.join(installDir, "app.asar"))) {
        return installDir;
    }
    return path.join(installDir, "resources");
}

function isInsideAntigravityProcessTree() {
    if (process.platform === "win32") return false;
    let pid = process.ppid;
    let hops = 0;
    while (pid && pid > 1 && hops < 24) {
        try {
            const out = child_process.execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"]
            }).trim();
            if (!out) break;
            const m = out.match(/^\s*(\d+)\s+(.*)$/);
            if (!m) break;
            const ppid = Number(m[1]);
            const comm = m[2] || "";
            if (comm.includes("/Antigravity.app/") || path.basename(comm) === "Antigravity") {
                return true;
            }
            if (ppid === pid) break;
            pid = ppid;
        } catch (e) {
            break;
        }
        hops++;
    }
    return false;
}

function seedDefaultPacks(quiet = false) {
    const home = os.homedir();
    const repoPacks = path.resolve(__dirname, "..", "packs");
    const targetPacksRoot = path.join(home, ".gemini", "meme-packs");
    const configPath = path.join(home, ".gemini", "meme-config.json");
    fs.mkdirSync(targetPacksRoot, { recursive: true });

    const srcNeko = path.join(repoPacks, "gemini-neko");
    const dstNeko = path.join(targetPacksRoot, "gemini-neko");
    if (fs.existsSync(srcNeko)) {
        fs.mkdirSync(dstNeko, { recursive: true });
        for (const f of ["manifest.json", "memes.json"]) {
            const s = path.join(srcNeko, f);
            const d = path.join(dstNeko, f);
            if (fs.existsSync(s) && !fs.existsSync(d)) {
                fs.copyFileSync(s, d);
            }
        }
        const srcMemesDir = path.join(srcNeko, "memes");
        const dstMemesDir = path.join(dstNeko, "memes");
        if (fs.existsSync(srcMemesDir)) {
            const walkCopy = (from, to) => {
                fs.mkdirSync(to, { recursive: true });
                for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
                    if (ent.name.startsWith(".")) continue;
                    const sf = path.join(from, ent.name);
                    const df = path.join(to, ent.name);
                    if (ent.isDirectory()) walkCopy(sf, df);
                    else if (ent.isFile() && !fs.existsSync(df)) fs.copyFileSync(sf, df);
                }
            };
            walkCopy(srcMemesDir, dstMemesDir);
        }
    }

    if (!fs.existsSync(configPath)) {
        const defCfg = {
            enabled: true,
            pickerSendOnClick: true,
            layoutMode: "inline",
            stickerSize: 168,
            activePacks: ["gemini-neko"],
            packsDirs: ["~/.gemini/meme-packs"]
        };
        fs.writeFileSync(configPath, JSON.stringify(defCfg, null, 2) + "\n", "utf8");
        if (!quiet) console.log("[初始化] 已创建默认配置: " + configPath);
    }
    return { targetPacksRoot, configPath };
}

function inspectStatus(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    const status = {
        resourcesDir,
        asarExists: fs.existsSync(asarPath),
        bakExists: fs.existsSync(bakPath),
        hasLocalization: false,
        hasMemeIpc: false,
        hasMemeRendererV2: false
    };
    if (status.asarExists) {
        const buf = fs.readFileSync(asarPath);
        status.hasLocalization = buf.includes("__ANTIGRAVITY_CHINESE_LOCALIZATION_START__");
        status.hasMemeIpc = buf.includes("__ANTIGRAVITY_IPC_MEME_START__");
        status.hasMemeRendererV2 = buf.includes(MEME_RENDERER_MARKER);
    }
    return status;
}

function atomicWritePatchedAsar(sourceAsar, targetAsar, filePatches) {
    const tempAsarPath = targetAsar + ".meme.tmp";
    try {
        AsarArchive.patchArchive(sourceAsar, tempAsarPath, filePatches);
        try {
            if (fs.existsSync(targetAsar)) fs.unlinkSync(targetAsar);
            fs.renameSync(tempAsarPath, targetAsar);
        } catch (renameErr) {
            fs.copyFileSync(tempAsarPath, targetAsar);
            try { fs.unlinkSync(tempAsarPath); } catch (_) {}
        }
        return true;
    } catch (err) {
        try { if (fs.existsSync(tempAsarPath)) fs.unlinkSync(tempAsarPath); } catch (_) {}
        console.error("[错误] 打包 app.asar 失败: " + err.message);
        return false;
    }
}

function installMemePatch(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) {
        console.error("[错误] 未在资源目录中找到 app.asar: " + resourcesDir);
        return false;
    }
    if (!fs.existsSync(bakPath)) {
        console.log("[备份] 首次注入，正在创建官方原始包备份 app.asar.bak ...");
        try {
            fs.copyFileSync(asarPath, bakPath);
        } catch (e) {
            reportWritePermissionError(resourcesDir, e, "备份到", "install.sh");
            return false;
        }
    }

    // 关键：从当前 app.asar 叠加读取，完美兼容原版英文与 antigravity-desktop-cn 汉化版
    const sourceAsar = fs.existsSync(asarPath) ? asarPath : bakPath;
    const preloadBuf = AsarArchive.readFile(sourceAsar, "dist/preload.js");
    const ipcBuf = AsarArchive.readFile(sourceAsar, "dist/ipcHandlers.js");
    if (!preloadBuf || !ipcBuf) {
        console.error("[错误] 无法从 app.asar 读取 dist/preload.js 或 dist/ipcHandlers.js");
        return false;
    }

    const filePatches = {};

    // 1. 修补 dist/preload.js（剥离旧块后追加独立表情渲染器）
    let preloadCleaned = removeMarkedBlocks(
        preloadBuf.toString("utf8"),
        PRELOAD_MEME_SIGNATURE_START,
        PRELOAD_MEME_SIGNATURE_END
    ).trimEnd();
    const preloadBlock = [
        "",
        PRELOAD_MEME_SIGNATURE_START,
        "(() => {",
        "    try {",
        "        const proto = (typeof globalThis !== 'undefined' && globalThis.location && typeof globalThis.location.protocol === 'string')",
        "            ? globalThis.location.protocol.toLowerCase()",
        "            : '';",
        "        if (proto === 'plugin:') return;",
        "        const elec = typeof electron_1 !== 'undefined' ? electron_1 : (typeof require === 'function' ? (() => { try { return require('electron'); } catch (_) { return null; } })() : null);",
        "        const invokeFn = (elec && elec.ipcRenderer && typeof elec.ipcRenderer.invoke === 'function')",
        "            ? elec.ipcRenderer.invoke.bind(elec.ipcRenderer)",
        "            : null;",
        "        (" + __agSetupMemeRenderer.toString() + ")(invokeFn);",
        "    } catch (e) { try { console.error('[AG-Meme Renderer]', e); } catch (_) {} }",
        "})();",
        PRELOAD_MEME_SIGNATURE_END,
        ""
    ].join("\n");
    const patchedPreload = preloadCleaned + "\n" + preloadBlock;
    try {
        new vm.Script(patchedPreload);
    } catch (err) {
        console.error("[致命错误] preload.js 注入语法校验失败: " + err.message);
        return false;
    }
    filePatches["dist/preload.js"] = patchedPreload;

    // 2. 修补 dist/ipcHandlers.js（剥离旧块后注入主进程 Meme IPC）
    let ipcCleaned = removeMarkedBlocks(
        ipcBuf.toString("utf8"),
        IPC_MEME_SIGNATURE_START,
        IPC_MEME_SIGNATURE_END
    );
    const regIpcMatch = ipcCleaned.match(/function\s+registerIpcHandlers\s*\([^)]*\)\s*\{/);
    if (!regIpcMatch) {
        console.error("[错误] 未能在 dist/ipcHandlers.js 中找到 registerIpcHandlers 函数插入点。");
        return false;
    }
    const regHeader = regIpcMatch[0];
    const regPos = ipcCleaned.indexOf(regHeader);
    const memeIpcBlock = [
        "",
        "    " + IPC_MEME_SIGNATURE_START,
        "    try {",
        "        const _agElec = typeof electron_1 !== 'undefined' ? electron_1 : require('electron');",
        "        (" + __agRegisterMemeIpcHandlers.toString() + ")(_agElec);",
        "    } catch (e) {",
        "        console.error('[AG-Meme IPC] Register failed:', e);",
        "    }",
        "    " + IPC_MEME_SIGNATURE_END
    ].join("\n");
    const patchedIpc = ipcCleaned.substring(0, regPos + regHeader.length) + memeIpcBlock + ipcCleaned.substring(regPos + regHeader.length);
    try {
        new vm.Script(patchedIpc);
    } catch (err) {
        console.error("[致命错误] ipcHandlers.js 注入语法校验失败: " + err.message);
        return false;
    }
    filePatches["dist/ipcHandlers.js"] = patchedIpc;

    console.log("[打包] 正在将 agy-meme 渲染器与 IPC 叠加写入 app.asar ...");
    if (!atomicWritePatchedAsar(sourceAsar, asarPath, filePatches)) return false;

    console.log("[√] agy-meme 桌面端视觉渲染器与 IPC 注入成功！");
    if (process.platform === "darwin" && !resignAppOnMac(resourcesDir)) {
        return false;
    }
    return true;
}

function uninstallMemePatch(resourcesDir, restoreBak = false) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    if (restoreBak) {
        if (!fs.existsSync(bakPath)) {
            console.error("[错误] 未找到备份文件 app.asar.bak，无法整包还原。");
            return false;
        }
        fs.copyFileSync(bakPath, asarPath);
        console.log("[√] 已从 app.asar.bak 整包还原官方原版 app.asar");
        return process.platform === "darwin" ? resignAppOnMac(resourcesDir) : true;
    }
    if (!fs.existsSync(asarPath)) {
        console.error("[错误] 未找到 app.asar: " + asarPath);
        return false;
    }
    const preloadBuf = AsarArchive.readFile(asarPath, "dist/preload.js");
    const ipcBuf = AsarArchive.readFile(asarPath, "dist/ipcHandlers.js");
    if (!preloadBuf || !ipcBuf) {
        console.error("[错误] 无法读取 app.asar 内容。");
        return false;
    }
    const rawPreload = preloadBuf.toString("utf8");
    const rawIpc = ipcBuf.toString("utf8");
    const cleanPreload = removeMarkedBlocks(rawPreload, PRELOAD_MEME_SIGNATURE_START, PRELOAD_MEME_SIGNATURE_END);
    const cleanIpc = removeMarkedBlocks(rawIpc, IPC_MEME_SIGNATURE_START, IPC_MEME_SIGNATURE_END);
    if (cleanPreload === rawPreload && cleanIpc === rawIpc) {
        console.log("[跳过] 当前 app.asar 未检测到 agy-meme 补丁标记，已是干净状态。");
        return true;
    }
    try {
        new vm.Script(cleanPreload);
        new vm.Script(cleanIpc);
    } catch (err) {
        console.error("[致命错误] 剥离 Meme 补丁后语法校验失败，已中止: " + err.message);
        return false;
    }
    const filePatches = {};
    if (cleanPreload !== rawPreload) filePatches["dist/preload.js"] = cleanPreload;
    if (cleanIpc !== rawIpc) filePatches["dist/ipcHandlers.js"] = cleanIpc;

    console.log("[还原] 正在从 app.asar 无损剥离 agy-meme 补丁（保留其余汉化与增强）...");
    if (!atomicWritePatchedAsar(asarPath, asarPath, filePatches)) return false;
    console.log("[√] agy-meme 补丁已无损卸载！");
    if (process.platform === "darwin" && !resignAppOnMac(resourcesDir)) {
        return false;
    }
    return true;
}

function main() {
    const args = process.argv.slice(2);
    let action = "install";
    let manualDir = "";
    let noKill = false;
    let checkWriteOnly = false;
    let restoreBak = false;
    let forceSelf = false;
    let jsonOut = false;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--install") action = "install";
        else if (a === "--uninstall") action = "uninstall";
        else if (a === "--status") action = "status";
        else if (a === "--seed-only") action = "seed";
        else if (a === "--no-kill") noKill = true;
        else if (a === "--restore-bak") restoreBak = true;
        else if (a === "--force-self") forceSelf = true;
        else if (a === "--check-write") checkWriteOnly = true;
        else if (a === "--json") jsonOut = true;
        else if (a === "--install-dir") { manualDir = args[++i] || ""; }
        else if (a.startsWith("--install-dir=")) manualDir = a.slice("--install-dir=".length);
        else if (a === "-h" || a === "--help") {
            console.log([
                "用法: node meme_patcher.js [选项]",
                "  --install             叠加注入桌面端猫娘渲染器与 IPC (默认)",
                "  --uninstall           无损剥离 Meme 补丁（保留中文汉化与其他插件）",
                "  --restore-bak         配合 --uninstall 从 app.asar.bak 整包还原",
                "  --status [--json]     只读查看 Antigravity.app 当前注入状态",
                "  --seed-only           仅初始化 ~/.gemini/meme-packs 与 meme-config.json",
                "  --install-dir <path>  手动指定 Antigravity 安装目录或沙箱目录",
                "  --no-kill             不尝试关闭/重启运行中的 Antigravity 进程",
                "  --check-write         仅检测写入权限 (退出码 0=可写, 2=需提权, 3=未找到)"
            ].join("\n"));
            process.exit(0);
        }
    }

    if (action === "seed") {
        seedDefaultPacks(false);
        process.exit(0);
    }

    const quietDetect = action === "status" || checkWriteOnly;
    const installDir = detectInstallationDir(manualDir, { quiet: quietDetect });
    if (!installDir) {
        if (jsonOut) console.log(JSON.stringify({ installed: false }));
        else if (!checkWriteOnly) console.error("[未找到] 未检测到 Antigravity Desktop 客户端。");
        process.exit(checkWriteOnly ? 3 : 1);
    }

    const resourcesDir = resolveResourcesDir(installDir);
    if (!fs.existsSync(resourcesDir)) {
        if (checkWriteOnly) process.exit(3);
        console.error("[错误] 无效的资源目录: " + resourcesDir);
        process.exit(1);
    }

    if (checkWriteOnly) {
        const asarPath = path.join(resourcesDir, "app.asar");
        if (!fs.existsSync(asarPath)) process.exit(3);
        try {
            fs.accessSync(resourcesDir, fs.constants.W_OK | fs.constants.X_OK);
            fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
            if (process.platform === "darwin") {
                const appBundle = findMacAppBundle(resourcesDir);
                if (appBundle) fs.accessSync(appBundle, fs.constants.W_OK | fs.constants.X_OK);
            }
            process.exit(0);
        } catch (e) {
            process.exit(2);
        }
    }

    if (action === "status") {
        const st = inspectStatus(resourcesDir);
        if (jsonOut) {
            console.log(JSON.stringify(st, null, 2));
        } else {
            console.log("Antigravity Resources: " + st.resourcesDir);
            console.log("  app.asar          : " + (st.asarExists ? "✅" : "❌"));
            console.log("  app.asar.bak      : " + (st.bakExists ? "✅" : "❌"));
            console.log("  中文汉化          : " + (st.hasLocalization ? "✅ 已注入" : "— 未注入 (英文原版)"));
            console.log("  agy-meme IPC      : " + (st.hasMemeIpc ? "✅" : "❌"));
            console.log("  agy-meme 渲染器v2 : " + (st.hasMemeRendererV2 ? "✅" : "❌"));
        }
        process.exit(0);
    }

    // 自杀防护：防止在 Antigravity 内置终端中直接覆盖/杀掉宿主 App
    if (!manualDir && !forceSelf && isInsideAntigravityProcessTree()) {
        console.error("[安全拦截] 检测到当前正运行在 Antigravity 桌面端会话内！");
        console.error("直接修补系统 /Applications/Antigravity.app 或结束进程会中断当前会话。");
        console.error("请在系统独立终端（Terminal / iTerm / Ghostty）中运行：");
        console.error("  node " + path.resolve(__filename) + " --" + action);
        process.exit(2);
    }

    if (!canWriteAntigravityResources(resourcesDir, action === "uninstall" ? "uninstall.sh" : "install.sh")) {
        process.exit(1);
    }

    const wasAppRunning = noKill ? false : checkIfAppIsRunning();
    if (!noKill && wasAppRunning) {
        if (!closeAntigravityProcesses()) process.exit(1);
    }

    let ok = false;
    if (action === "install") {
        seedDefaultPacks(false);
        ok = installMemePatch(resourcesDir);
    } else if (action === "uninstall") {
        ok = uninstallMemePatch(resourcesDir, restoreBak);
    }
    if (!ok) process.exit(1);

    if (wasAppRunning && !noKill) {
        try {
            if (process.platform === "darwin") {
                const targetApp = findMacAppBundle(resourcesDir);
                if (targetApp) child_process.spawn("open", [targetApp], { detached: true, stdio: "ignore" }).unref();
            } else if (process.platform === "win32") {
                const exePath = path.join(path.dirname(resourcesDir), "Antigravity.exe");
                if (fs.existsSync(exePath)) {
                    child_process.spawn(exePath, [], { detached: true, stdio: "ignore" }).unref();
                }
            } else if (process.platform === "linux") {
                const binPath = path.join(path.dirname(resourcesDir), "antigravity");
                const cmd = fs.existsSync(binPath) ? binPath : "antigravity";
                child_process.spawn(cmd, [], { detached: true, stdio: "ignore" }).unref();
            }
        } catch (_) {}
    }
}

main();
