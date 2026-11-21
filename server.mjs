#!/usr/bin/env node
/**
 * agy-meme MCP Server (Zero-dependency Node ESM stdio JSON-RPC)
 *
 * 读取 ~/.gemini/meme-config.json 与 ~/.gemini/meme-packs/<pack>/memes.json
 * （自动回落插件内置 ./packs 与 SQLite index.db），
 * 向 Antigravity Desktop 提供 send_meme / meme_list / learn_meme / meme_update 四个工具；
 * 在 agy CLI / IDE / ACP 等非桌面端宿主下自动静默隔离，不暴露工具。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  cpSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_DIR = resolve(process.env.PLUGIN_ROOT || SCRIPT_DIR);
const BUNDLED_PACKS_DIR = join(PLUGIN_ROOT_DIR, 'packs');
const CONFIG_PATH = join(HOME, '.gemini', 'meme-config.json');
const DEFAULT_PACKS_DIR = join(HOME, '.gemini', 'meme-packs');
const ALLOWED_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);

function isAntigravityDesktopHost() {
  const override = String(process.env.AGY_MEME_HOST || '').trim().toLowerCase();
  if (override === 'desktop') return true;
  if (override === 'cli') return false;

  // 优先检查直接宿主注入的 PLUGIN_DATA（避免误信桌面版内置终端继承的 __CFBundleIdentifier）
  const pluginData = String(process.env.PLUGIN_DATA || '').replace(/\\/g, '/');
  if (/\/antigravity-(?:cli|ide|acp)(?:\/|$)/i.test(pluginData)) {
    return false;
  }
  if (/\/antigravity\/plugin_data(?:\/|$)/i.test(pluginData)) {
    return true;
  }

  // 若 PLUGIN_DATA 缺失，则检查直接父进程命令行（POSIX）
  if (process.platform !== 'win32') {
    try {
      const ppidCmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(process.ppid)], {
        encoding: 'utf8',
        timeout: 1500,
      }).trim();
      if (/(?:^|[\s/])agy(?:\s|$)/.test(ppidCmd) || /antigravity-cli|--cli_dir_name/.test(ppidCmd)) {
        return false;
      }
      if (ppidCmd.includes('Antigravity.app/') || ppidCmd.includes('--subclient_type hub')) {
        return true;
      }
    } catch {}
  }

  if (process.env.__CFBundleIdentifier === 'com.google.antigravity') {
    return true;
  }
  return false;
}

const IS_DESKTOP_HOST = isAntigravityDesktopHost();

const MOODS = {
  happy: ['happy', 'like', 'meow'],
  angry: ['angry', 'fool', 'baka'],
  sad: ['sad', 'sigh'],
  shy: ['shy'],
  confused: ['confused', 'surprised', 'see'],
  daily: ['daily', 'sleep', 'morning', 'work', 'reply'],
};

const MOOD_WORDS = {
  happy: '开心 高兴 兴奋 喜欢 卖萌 可爱 比心 哈哈 欢迎 得意 好耶 满意 赞 期待 嚣张 狂拽 耍帅 cool 酷 拿捏 打call 应援 庆祝 干杯 敬酒 气场 霸气 坏笑 计划通 happy cheerful celebrate love praise awesome swagger laugh lgtm pass launch',
  angry: '生气 愤怒 暴躁 笨蛋 嫌弃 哈气 炸毛 怒 无语 达咩 傲娇 哼 吐槽 死鱼眼 指正 敲黑板 抓狂 angry mad rage pout hiss tsundere deadpan grumpy',
  sad: '难过 哭 委屈 叹气 求饶 沮丧 崩溃 沉淀 道歉 对不起 认错 滑跪 燃尽 融化 累瘫 汗流浃背 慌张 sad cry sob tears sorry apology melted tired panic',
  shy: '害羞 腼腆 脸红 花痴 撒娇 摸摸头 献花 捧心 捏脸 崇拜 星星眼 捂脸 尴尬 社死 偷偷看 抱抱 shy blush headpat hug flower awe cute facepalm',
  confused: '困惑 疑惑 惊讶 问号 懵 惊呆 震惊 慌张 宕机 怀疑 发呆 思考 烧脑 放大镜 排查 查bug 暗中观察 摊手 无奈 脑洞 confused think question detective bug mindblown shocked shrug peek',
  daily: '困 睡觉 早上好 打招呼 你好 上班 下班 摸鱼 工作 咖啡 吃瓜 吃饭 奶茶 敲代码 编程 捉虫 敬礼 收到 记笔记 上菜 交付 晚安 日常 daily coding laptop coffee boba tea watermelon sleep goodnight salute note',
};

const RECENT_CAPTION_LIMIT = 14;
const recentCaptions = [];

function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return HOME;
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(HOME, s.slice(2));
  return s;
}

function readConfig() {
  const def = {
    enabled: true,
    pickerSendOnClick: true,
    layoutMode: 'inline',
    stickerSize: 168,
    activePacks: ['gemini-neko'],
    packsDirs: [DEFAULT_PACKS_DIR],
  };
  try {
    if (!existsSync(CONFIG_PATH)) return def;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return def;
    const packsDirs = Array.isArray(raw.packsDirs) && raw.packsDirs.length > 0
      ? raw.packsDirs.map(expandHome).filter(Boolean)
      : [DEFAULT_PACKS_DIR];
    const activePacks = Array.isArray(raw.activePacks) && raw.activePacks.length > 0
      ? raw.activePacks.map(String).filter(Boolean)
      : ['gemini-neko'];
    return { ...def, ...raw, packsDirs, activePacks };
  } catch {
    return def;
  }
}

function discoverPacks(cfg) {
  const seen = new Map();
  const searchDirs = [...cfg.packsDirs];
  if (!searchDirs.some((d) => resolve(expandHome(d)) === BUNDLED_PACKS_DIR)) {
    searchDirs.push(BUNDLED_PACKS_DIR);
  }

  for (const rawDir of searchDirs) {
    const dir = resolve(expandHome(rawDir));
    if (!existsSync(dir)) continue;
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const packDir = join(dir, name);
      try {
        if (!statSync(packDir).isDirectory()) continue;
      } catch { continue; }
      const memesJsonPath = join(packDir, 'memes.json');
      const indexDbPath = join(packDir, 'index.db');
      if (!existsSync(memesJsonPath) && !existsSync(indexDbPath)) continue;
      if (seen.has(name)) continue;
      let manifest = { id: name, name, description: '' };
      try {
        if (existsSync(join(packDir, 'manifest.json'))) {
          manifest = { ...manifest, ...JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) };
        }
      } catch {}
      seen.set(name, { id: name, dir: packDir, manifest, memesJsonPath, indexDbPath });
    }
  }
  return [...seen.values()];
}

function loadPackRows(pack) {
  // Primary: memes.json (zero native addon & fast)
  if (existsSync(pack.memesJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(pack.memesJsonPath, 'utf8'));
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.memes) ? data.memes : []);
      if (rows.length > 0) {
        return rows.map((r) => ({
          ...r,
          packId: pack.id,
          packName: pack.manifest.name || pack.id,
          absPath: resolve(pack.dir, String(r.path || '')),
        }));
      }
    } catch {}
  }
  // Fallback: SQLite index.db via sqlite3 -json
  if (existsSync(pack.indexDbPath)) {
    try {
      const sqliteBin = existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
      const out = execFileSync(
        sqliteBin,
        ['-readonly', '-json', pack.indexDbPath, 'SELECT path, tag, file_name, caption, keywords, mtime, captioned_at FROM memes;'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
      );
      const rows = JSON.parse(out || '[]');
      if (Array.isArray(rows)) {
        return rows.map((r) => ({
          ...r,
          packId: pack.id,
          packName: pack.manifest.name || pack.id,
          absPath: resolve(pack.dir, String(r.path || '')),
        }));
      }
    } catch {}
  }
  return [];
}

function ensureWritablePackSeeded(packId) {
  const packDir = join(DEFAULT_PACKS_DIR, packId);
  if (!existsSync(join(packDir, 'memes.json'))) {
    const bundled = join(BUNDLED_PACKS_DIR, packId);
    if (existsSync(bundled)) {
      mkdirSync(DEFAULT_PACKS_DIR, { recursive: true });
      cpSync(bundled, packDir, { recursive: true });
    }
  }
  return packDir;
}

function normalizeTag(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return '';
  if (MOODS[t]) return t;
  for (const [mood, fine] of Object.entries(MOODS)) {
    if (fine.includes(t)) return mood;
  }
  return t;
}

function inferMoodFromQuery(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return '';
  if (MOODS[s]) return s;
  for (const [mood, words] of Object.entries(MOOD_WORDS)) {
    if (words.split(/\s+/).some((w) => w && s.includes(w))) return mood;
  }
  return '';
}

function tokenizeQuery(q) {
  return [...new Set(
    String(q || '')
      .trim()
      .toLowerCase()
      .split(/[\s,，。、!！?？/\\|;；·]+/)
      .filter(Boolean)
  )];
}

function shuffleWithRecentBias(rows, excludeSet) {
  const fresh = [];
  const stale = [];
  for (const r of rows) {
    if (excludeSet.has(r.caption) || recentCaptions.includes(r.caption)) stale.push(r);
    else fresh.push(r);
  }
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  return [...shuffle(fresh), ...shuffle(stale)];
}

function rememberCaptions(rows) {
  for (const r of rows) {
    if (!r.caption) continue;
    const idx = recentCaptions.indexOf(r.caption);
    if (idx !== -1) recentCaptions.splice(idx, 1);
    recentCaptions.push(r.caption);
  }
  while (recentCaptions.length > RECENT_CAPTION_LIMIT) recentCaptions.shift();
}

function loadActiveMemes(packFilter = '') {
  const cfg = readConfig();
  const packs = discoverPacks(cfg);
  const want = packFilter
    ? packs.filter((p) => p.id === packFilter)
    : packs.filter((p) => cfg.activePacks.includes(p.id));
  const usePacks = want.length > 0 ? want : packs;
  const allRows = [];
  for (const p of usePacks) {
    allRows.push(...loadPackRows(p));
  }
  return { cfg, packs, usePacks, allRows };
}

function handleSendMeme(args = {}) {
  const query = String(args.query || '').trim();
  const rawMood = normalizeTag(args.mood || args.tag || '');
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 6));
  const excludeList = Array.isArray(args.exclude) ? args.exclude.map(String) : [];
  const excludeSet = new Set(excludeList);

  const { allRows } = loadActiveMemes(args.pack_id || '');
  if (allRows.length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: '当前没有可用的 Gemini 猫娘表情库，请检查 ~/.gemini/meme-packs/gemini-neko 或插件内置 packs 目录。' }],
    };
  }

  let pool = allRows;
  if (rawMood && MOODS[rawMood]) {
    const fine = new Set(MOODS[rawMood]);
    pool = allRows.filter((r) => fine.has(String(r.tag || '').toLowerCase()));
  } else if (rawMood) {
    pool = allRows.filter((r) => String(r.tag || '').toLowerCase() === rawMood);
  }

  let matched = [];
  let mode = 'mood';
  if (query) {
    const tokens = tokenizeQuery(query);
    const scored = [];
    for (const r of pool) {
      const capLower = String(r.caption || '').toLowerCase();
      const kwLower = String(r.keywords || '').toLowerCase();
      const sceneLower = String(r.scene || '').toLowerCase();
      const hay = `${capLower} ${kwLower} ${sceneLower} ${String(r.file_name || '').toLowerCase()} ${String(r.tag || '').toLowerCase()}`;
      let score = 0;
      for (const t of tokens) {
        if (!hay.includes(t)) continue;
        if (capLower.includes(t)) score += 4;
        else if (kwLower.includes(t)) score += 3;
        else if (sceneLower.includes(t)) score += 2;
        else score += 1;
      }
      if (score > 0) {
        // 同分情况下优先推荐无固定台词束缚的纯表情通配贴纸
        if (!r.text_overlay) score += 0.35;
        scored.push({ r, score });
      }
    }
    if (scored.length > 0) {
      mode = 'keyword';
      scored.sort((a, b) => b.score - a.score);
      const top = scored.filter((x) => x.score >= scored[0].score - 1.2).map((x) => x.r);
      const rest = scored.filter((x) => x.score < scored[0].score - 1.2).map((x) => x.r);
      matched = [...shuffleWithRecentBias(top, excludeSet), ...shuffleWithRecentBias(rest, excludeSet)].slice(0, limit);
    }
  }

  let fallbackNote = '';
  if (matched.length === 0) {
    const inferred = rawMood || inferMoodFromQuery(query) || '';
    if (query) {
      fallbackNote = `关键词「${query}」未精确命中${inferred ? `，已自动按情绪「${inferred}」抽取` : '，已从图库随机挑选'}。\n`;
    }
    let moodPool = pool;
    if (inferred && MOODS[inferred]) {
      const fine = new Set(MOODS[inferred]);
      const filtered = allRows.filter((r) => fine.has(String(r.tag || '').toLowerCase()));
      if (filtered.length > 0) moodPool = filtered;
    }
    // 随机兜底时优先排布无固定台词的纯动作表情，避免误发窄梗配字图
    const purePool = moodPool.filter((r) => !r.text_overlay);
    const textPool = moodPool.filter((r) => Boolean(r.text_overlay));
    matched = [...shuffleWithRecentBias(purePool, excludeSet), ...shuffleWithRecentBias(textPool, excludeSet)].slice(0, limit);
  }

  rememberCaptions(matched);

  const lines = matched.map((m, i) => {
    const cap = String(m.caption || m.file_name || '').slice(0, 80);
    const textTag = m.text_overlay ? `含配字「${m.text_overlay}」(仅限字面语境契合时用)` : '无字纯表情';
    const scenePart = m.scene ? ` | 画面与适用=${m.scene}` : '';
    return `${i + 1}. [表情: ${cap}] | 情绪=${m.tag} | 类型=${textTag}${scenePart} | 关键词=${m.keywords || ''}`;
  });

  const instruction =
    '选图契约：1) 先看「画面与适用」及「类型」——凡标注 `含配字「...」` 的候选，必须在该台词与当前对话字面意思 100% 严丝合缝时才可选用，严禁拿具体窄梗图去充当宽泛情绪；2) 常规情绪互动优先挑选 `无字纯表情` 中神态动作最传神的 1 张；3) 挑中后将 `[表情: 描述]` 原样单独占一行写入回复（禁改字、禁加路径/URL）；若无真正贴切候选则宁缺毋滥不发表情。';

  return {
    content: [
      {
        type: 'text',
        text: `${fallbackNote}共返回 ${matched.length} 张 Gemini 猫娘候选：\n${instruction}\n\n${lines.join('\n')}`,
      },
    ],
    structuredContent: {
      mode,
      count: matched.length,
      candidates: matched.map((m) => ({
        caption: m.caption,
        marker: `[表情: ${m.caption}]`,
        tag: m.tag,
        hasText: Boolean(m.text_overlay),
        textOverlay: m.text_overlay || null,
        scene: m.scene || '',
        keywords: m.keywords,
        packId: m.packId,
        file: m.file_name,
      })),
    },
  };
}

function handleMemeList(args = {}) {
  const mood = normalizeTag(args.mood || args.tag || '');
  const packId = String(args.pack_id || '').trim();
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 60));

  const { cfg, packs, allRows } = loadActiveMemes(packId);
  const filtered = mood ? allRows.filter((r) => normalizeTag(r.tag) === mood) : allRows;

  const counts = {};
  for (const r of allRows) {
    const k = normalizeTag(r.tag) || 'misc';
    counts[k] = (counts[k] || 0) + 1;
  }

  const summaryCounts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}(${n})`)
    .join(' / ');

  const packSummary = packs
    .map((p) => `${p.id}(${p.manifest.name || p.id}${cfg.activePacks.includes(p.id) ? ', 已启用' : ''})`)
    .join('，');

  const lines = filtered.slice(0, limit).map((m, i) => {
    const txtBadge = m.text_overlay ? ` [配字:${m.text_overlay}]` : '';
    const sceneBrief = m.scene ? ` | ${m.scene}` : '';
    return `${i + 1}. [${m.tag}] ${m.caption}${txtBadge} (${m.file_name}) — ${m.keywords || ''}${sceneBrief}`;
  });

  return {
    content: [
      {
        type: 'text',
        text: `图库列表：${packSummary || '无'}\n情绪分布：${summaryCounts || '空'}\n显示 ${Math.min(filtered.length, limit)} / ${filtered.length} 张：\n\n${lines.join('\n')}`,
      },
    ],
  };
}

function syncPackSqlite(packDir, rows, manifest) {
  const manifestPath = join(packDir, 'manifest.json');
  const memesJsonPath = join(packDir, 'memes.json');
  const dbPath = join(packDir, 'index.db');

  const nextManifest = { ...manifest, count: rows.length };
  writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');
  writeFileSync(memesJsonPath, JSON.stringify({ manifest: nextManifest, memes: rows }, null, 2) + '\n', 'utf8');

  // Best-effort index.db rebuild via parameterized python3 sqlite3
  const pyScript = `
import json, sqlite3, sys
data = json.loads(sys.stdin.read())
db = sqlite3.connect(data["dbPath"])
db.execute("""CREATE TABLE IF NOT EXISTS memes (
  path TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT,
  caption TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  mtime REAL,
  captioned_at REAL
)""")
db.execute("DELETE FROM memes")
for r in data["rows"]:
    db.execute(
        "INSERT INTO memes(path, tag, file_name, file_hash, caption, keywords, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (r.get("path",""), r.get("tag","daily"), r.get("file_name",""), r.get("file_hash",""), r.get("caption",""), r.get("keywords",""), r.get("mtime"), r.get("captioned_at"))
    )
db.commit()
db.close()
`;
  try {
    execFileSync('python3', ['-c', pyScript], {
      input: JSON.stringify({ dbPath, rows }),
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {}
}

function slugify(text) {
  const ascii = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii && ascii.length >= 3) return ascii.slice(0, 40);
  return 'sticker-' + createHash('sha1').update(String(text || Date.now())).digest('hex').slice(0, 8);
}

function handleLearnMeme(args = {}) {
  const srcRaw = expandHome(args.image_path || '');
  const caption = String(args.caption || '').trim().slice(0, 120);
  const tag = normalizeTag(args.tag || 'daily') || 'daily';
  const keywords = String(args.keywords || '').trim() || `${caption} Gemini猫娘`;
  const packId = String(args.pack_id || 'gemini-neko').trim() || 'gemini-neko';

  if (!srcRaw || !existsSync(srcRaw)) {
    return { isError: true, content: [{ type: 'text', text: `找不到源图片文件：${srcRaw}` }] };
  }
  if (!caption) {
    return { isError: true, content: [{ type: 'text', text: '必须提供简短清晰的 caption 描述（用于 [表情: 描述] 匹配）。' }] };
  }
  const ext = extname(srcRaw).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return { isError: true, content: [{ type: 'text', text: `不支持的图片扩展名 ${ext}，仅支持 .webp/.png/.jpg/.jpeg/.gif` }] };
  }

  const packDir = ensureWritablePackSeeded(packId);
  const tagDir = join(packDir, 'memes', tag);
  mkdirSync(tagDir, { recursive: true });

  let manifest = { id: packId, name: packId === 'gemini-neko' ? 'Gemini猫娘' : packId, version: '1.2.0' };
  try {
    if (existsSync(join(packDir, 'manifest.json'))) {
      manifest = { ...manifest, ...JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) };
    }
  } catch {}

  let rows = [];
  const memesJsonPath = join(packDir, 'memes.json');
  if (existsSync(memesJsonPath)) {
    try {
      const d = JSON.parse(readFileSync(memesJsonPath, 'utf8'));
      rows = Array.isArray(d) ? d : (Array.isArray(d?.memes) ? d.memes : []);
    } catch {}
  }

  const stem = slugify(caption);
  let fileName = `${stem}${ext}`;
  let relPath = `memes/${tag}/${fileName}`;
  let dest = join(packDir, relPath);
  if (existsSync(dest)) {
    fileName = `${stem}-${Date.now().toString(36)}${ext}`;
    relPath = `memes/${tag}/${fileName}`;
    dest = join(packDir, relPath);
  }

  copyFileSync(srcRaw, dest);
  const bytes = readFileSync(dest);
  const fhash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const mtime = statSync(dest).mtimeMs / 1000;
  const nowSec = Date.now() / 1000;

  rows.push({
    path: relPath,
    tag,
    file_name: fileName,
    file_hash: fhash,
    caption,
    keywords,
    mtime,
    captioned_at: nowSec,
  });

  syncPackSqlite(packDir, rows, manifest);

  return {
    content: [
      {
        type: 'text',
        text: `已收录新表情到 ${packId}！\n- 标记：[表情: ${caption}]\n- 分类：${tag}\n- 关键词：${keywords}\n- 文件：${relPath}\n当前图库共 ${rows.length} 张。`,
      },
    ],
  };
}

function handleMemeUpdate(args = {}) {
  const target = String(args.caption_or_file || args.target || '').trim();
  const packId = String(args.pack_id || 'gemini-neko').trim() || 'gemini-neko';
  if (!target) {
    return { isError: true, content: [{ type: 'text', text: '请提供要修改的表情 caption、file_name 或 path。' }] };
  }
  const packDir = ensureWritablePackSeeded(packId);
  const memesJsonPath = join(packDir, 'memes.json');
  if (!existsSync(memesJsonPath)) {
    return { isError: true, content: [{ type: 'text', text: `找不到图库：${packDir}` }] };
  }
  const data = JSON.parse(readFileSync(memesJsonPath, 'utf8'));
  const manifest = data.manifest || { id: packId, name: packId, version: '1.2.0' };
  const rows = Array.isArray(data.memes) ? data.memes : [];

  const idx = rows.findIndex(
    (r) => r.caption === target || r.file_name === target || r.path === target
  );
  if (idx === -1) {
    return { isError: true, content: [{ type: 'text', text: `未在图库 ${packId} 中找到匹配的条目：${target}` }] };
  }

  if (typeof args.new_caption === 'string' && args.new_caption.trim()) {
    rows[idx].caption = args.new_caption.trim().slice(0, 120);
  }
  if (typeof args.keywords === 'string' && args.keywords.trim()) {
    rows[idx].keywords = args.keywords.trim();
  }
  if (typeof args.tag === 'string' && args.tag.trim()) {
    rows[idx].tag = normalizeTag(args.tag) || rows[idx].tag;
  }
  rows[idx].captioned_at = Date.now() / 1000;

  syncPackSqlite(packDir, rows, manifest);

  return {
    content: [
      {
        type: 'text',
        text: `已更新表情元数据：\n- 标记：[表情: ${rows[idx].caption}]\n- 分类：${rows[idx].tag}\n- 关键词：${rows[idx].keywords}\n- 路径：${rows[idx].path}`,
      },
    ],
  };
}

const TOOLS = [
  {
    name: 'send_meme',
    description:
      '【仅限 Antigravity 桌面版使用】查找并返回可供回复使用的 Gemini 猫娘表情包候选。支持按情绪桶 mood (happy/shy/angry/sad/confused/daily) 随机抽选或按 query 关键词检索。挑中后将返回的 `[表情: 描述]` 原样写进回复正文（不加网址），Antigravity 桌面版会自动渲染成表情贴纸；命令行/非桌面端请勿使用。',
    inputSchema: {
      type: 'object',
      properties: {
        mood: {
          type: 'string',
          description: '情绪分类：happy(开心/卖萌) / shy(害羞/撒娇) / angry(生气/哈气) / sad(难过/委屈) / confused(困惑/震惊/呆) / daily(日常/咖啡/睡觉/吃瓜)',
          enum: ['happy', 'shy', 'angry', 'sad', 'confused', 'daily'],
        },
        query: {
          type: 'string',
          description: '搜索关键词，如“爱心眼”“哈气”“咖啡”“哭”“比心”“吃瓜”“摸摸头”等',
        },
        limit: {
          type: 'integer',
          description: '返回候选数量（1~20，默认 6）',
          default: 6,
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: '需要排除的近期已发过的 caption',
        },
      },
    },
  },
  {
    name: 'meme_list',
    description: '查看当前已启用的 Gemini 猫娘表情库、各情绪分类统计及所有表情描述列表。',
    inputSchema: {
      type: 'object',
      properties: {
        mood: {
          type: 'string',
          description: '按情绪筛选（可选）',
        },
        pack_id: {
          type: 'string',
          description: '指定图库 ID（可选）',
        },
        limit: {
          type: 'integer',
          description: '最多展示条数，默认 40',
          default: 40,
        },
      },
    },
  },
  {
    name: 'learn_meme',
    description: '将用户指定的本地图片导入并收录进 Gemini 猫娘表情包图库，同步更新 JSON 与 SQLite 索引。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '本地图片文件绝对路径（支持 webp/png/jpg/gif）' },
        caption: { type: 'string', description: '简短唯一的表情描述文案（前端 [表情: ...] 匹配键）' },
        tag: {
          type: 'string',
          description: '所属情绪分类',
          enum: ['happy', 'shy', 'angry', 'sad', 'confused', 'daily'],
          default: 'daily',
        },
        keywords: { type: 'string', description: '空格分隔的检索关键词' },
        pack_id: { type: 'string', description: '目标图库 ID，默认 gemini-neko', default: 'gemini-neko' },
      },
      required: ['image_path', 'caption'],
    },
  },
  {
    name: 'meme_update',
    description: '修改已有表情的描述文案、关键词或情绪分类。',
    inputSchema: {
      type: 'object',
      properties: {
        caption_or_file: { type: 'string', description: '当前 caption、文件名或相对路径' },
        new_caption: { type: 'string', description: '新的描述文案（可选）' },
        keywords: { type: 'string', description: '新的空格分隔关键词（可选）' },
        tag: { type: 'string', description: '新的情绪分类（可选）' },
        pack_id: { type: 'string', description: '目标图库 ID，默认 gemini-neko', default: 'gemini-neko' },
      },
      required: ['caption_or_file'],
    },
  },
];

function sendRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleRequest(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      const clientProto = params && typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : '2024-11-05';
      sendRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientProto,
          capabilities: { tools: {} },
          serverInfo: { name: 'agy-meme', version: '1.2.0' },
        },
      });
      return;
    }
    if (method === 'ping') {
      sendRpc({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      sendRpc({ jsonrpc: '2.0', id, result: { tools: IS_DESKTOP_HOST ? TOOLS : [] } });
      return;
    }
    if (method === 'tools/call') {
      if (!IS_DESKTOP_HOST) {
        sendRpc({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: '当前运行在 Antigravity CLI（命令行终端）或非桌面端环境，终端不支持渲染表情贴纸。严禁调用表情工具或在回复中输出任何 [表情: ...] 标记，请直接用正常文字回复。',
              },
            ],
          },
        });
        return;
      }
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      let res;
      if (name === 'send_meme') res = handleSendMeme(args);
      else if (name === 'meme_list') res = handleMemeList(args);
      else if (name === 'learn_meme') res = handleLearnMeme(args);
      else if (name === 'meme_update') res = handleMemeUpdate(args);
      else {
        res = { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
      sendRpc({ jsonrpc: '2.0', id, result: res });
      return;
    }
    sendRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const nl = buf.indexOf('\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handleRequest(JSON.parse(line));
    } catch {}
  }
});
process.stdin.on('end', () => {
  const rest = buf.trim();
  if (rest) {
    try { handleRequest(JSON.parse(rest)); } catch {}
  }
  process.exit(0);
});
