---
name: agy-meme
description: >-
  Manage Gemini Neko sticker packs, inspect sticker moods, import custom local
  images as chat stickers, and set up or verify the Antigravity Desktop ASAR
  renderer patch. Use when the user asks to browse available stickers, add new
  sticker images, update sticker captions/tags, or enable/check desktop inline
  sticker rendering for agy-meme.
---

# agy-meme Sticker & Desktop Renderer Skill

`agy-meme` pairs an MCP sticker server (`send_meme`, `meme_list`, `learn_meme`, `meme_update`) with a standalone Electron ASAR overlay patcher (`scripts/meme_patcher.js`) so `[表情: caption]` markers render as inline Neko stickers inside Antigravity Desktop chat bubbles (alongside an input-box sticker picker via `Cmd/Ctrl+Shift+M`).

> [!IMPORTANT]
> - Sticker rendering and MCP tools are **Desktop-only**. In `agy` CLI / IDE / ACP sessions, `server.mjs` automatically hides all tools so CLI conversations remain clean text-only.
> - **Never kill or patch a live `/Applications/Antigravity.app` from inside an Antigravity Desktop agent session.** Always check status read-only with `--status`, or instruct the user to run the installer/patcher in an external terminal.

## Workflows

### 1. Browse or test stickers in conversation
1. Use `meme_list` (optionally filtering by `mood`: `happy`, `shy`, `angry`, `sad`, `confused`, `daily`) to inspect installed stickers and counts.
2. When a conversational moment fits, call `send_meme` (`mood` or `query`), pick one candidate, and place `[表情: <exact caption>]` on its own line in your response (Desktop only).

### 2. Import custom stickers or update captions
1. To add a local `.webp` / `.png` / `.jpg` / `.gif` image into `~/.gemini/meme-packs/gemini-neko`:
   call `learn_meme` with `image_path`, a short unique `caption`, `tag` (`happy|shy|angry|sad|confused|daily`), and space-separated `keywords`.
2. Users can also click the `+` (`+ 添图`) button inside the Desktop composer sticker picker (`Cmd/Ctrl+Shift+M`) to import images interactively.
3. To rename or re-tag an existing sticker, call `meme_update` with `caption_or_file` and any of `new_caption`, `keywords`, or `tag`.

### 3. Check or enable the Desktop visual renderer
After installing the plugin via `agy plugin install`, run the ASAR status check read-only from the plugin directory:

```bash
node scripts/meme_patcher.js --status
```

If Desktop inline rendering is not yet injected (or after an Antigravity Desktop app update overwrites `app.asar`), instruct the user to close Antigravity Desktop and run in an **external** terminal:

- **macOS / Linux**:
  ```bash
  node ~/.gemini/config/plugins/agy-meme/scripts/meme_patcher.js --install
  ```
- **Windows (PowerShell)**:
  ```powershell
  node "$env:USERPROFILE\.gemini\config\plugins\agy-meme\scripts\meme_patcher.js" --install
  ```

To cleanly strip the visual renderer patch without affecting English or Chinese (`antigravity-desktop-cn`) UI localization:

```bash
node ~/.gemini/config/plugins/agy-meme/scripts/meme_patcher.js --uninstall
```
