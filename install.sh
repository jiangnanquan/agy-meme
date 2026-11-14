#!/usr/bin/env bash
set -euo pipefail

# agy-meme 一键安装与桌面端叠加注入脚本（macOS / Linux）
# 支持两类用法：
#   1. ./install.sh                  同步插件到 ~/.gemini/config/plugins/agy-meme，并叠加注入 Antigravity Desktop
#   2. ./install.sh --plugin-only    仅同步插件与图库，不修改 Antigravity.app（适合从内置终端运行或仅预置 MCP）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PATCHER="$SCRIPT_DIR/scripts/meme_patcher.js"

if [ ! -f "$PATCHER" ]; then
  echo "[错误] 未找到补丁脚本: $PATCHER" >&2
  exit 1
fi

PLUGIN_ONLY=0
NO_KILL=0
MANUAL_DIR=""
PASSTHROUGH_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-only)
      PLUGIN_ONLY=1
      shift
      ;;
    --no-kill)
      NO_KILL=1
      PASSTHROUGH_ARGS+=("--no-kill")
      shift
      ;;
    --install-dir)
      if [ $# -lt 2 ]; then
        echo "[错误] --install-dir 需要传入目录路径" >&2
        exit 1
      fi
      MANUAL_DIR="$2"
      PASSTHROUGH_ARGS+=("--install-dir" "$2")
      shift 2
      ;;
    --install-dir=*)
      MANUAL_DIR="${1#*=}"
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./install.sh [选项]

选项:
  --plugin-only           仅同步 MCP 插件与默认贴纸包到 ~/.gemini，不修补 Antigravity Desktop
  --install-dir <path>    手动指定 Antigravity 安装目录（或离线沙箱测试目录）
  --no-kill               注入时不自动关闭 / 重启正在运行的 Antigravity Desktop
  -h, --help              显示此帮助信息
EOF
      exit 0
      ;;
    *)
      echo "[错误] 未知参数: $1" >&2
      exit 1
      ;;
  esac
done

resolve_target_user_home() {
  if [ "${EUID:-$(id -u)}" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || eval echo "~$SUDO_USER"
    else
      getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || eval echo "~$SUDO_USER"
    fi
  else
    printf '%s\n' "$HOME"
  fi
}

find_node_bin() {
  local cand
  if [ -n "${AGY_MEME_NODE_BIN:-}" ] && [ -x "${AGY_MEME_NODE_BIN}" ]; then
    printf '%s\n' "$AGY_MEME_NODE_BIN"
    return 0
  fi

  for cand in \
    "$(command -v node 2>/dev/null || true)" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      case "$cand" in
        *fnm_multishells*)
          cand="$("$cand" -e 'process.stdout.write(require("fs").realpathSync(process.execPath))' 2>/dev/null || true)"
          ;;
      esac
      if [ -n "$cand" ] && [ -x "$cand" ]; then
        printf '%s\n' "$cand"
        return 0
      fi
    fi
  done

  local home_dir
  home_dir="$(resolve_target_user_home)"
  for cand in \
    "$home_dir/.local/share/fnm/aliases/default/bin/node" \
    "$home_dir/.fnm/aliases/default/bin/node" \
    "$home_dir/.volta/bin/node" \
    "$home_dir/.nvm/versions/node"/*/bin/node \
    "$home_dir/.local/share/fnm/node-versions"/*/installation/bin/node; do
    if [ -x "$cand" ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node_bin || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[错误] 未找到 Node.js (需要 v18+)。请先安装 Node.js 或设置 PATH 后重试。" >&2
  exit 1
fi

NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd -P)"
export PATH="$NODE_DIR:$PATH"

TARGET_HOME="$(resolve_target_user_home)"
PLUGIN_DST="$TARGET_HOME/.gemini/config/plugins/agy-meme"
mkdir -p "$PLUGIN_DST"
PLUGIN_DST_REAL="$(cd "$PLUGIN_DST" && pwd -P)"

echo "=================================================="
echo "  agy-meme 安装器 (Node: $NODE_BIN)"
echo "=================================================="

# 1. 同步插件目录到 ~/.gemini/config/plugins/agy-meme（保留用户现有的 meme-config.json）
if [ "$SCRIPT_DIR" != "$PLUGIN_DST_REAL" ]; then
  echo "[1/3] 同步插件文件至: $PLUGIN_DST"
  for f in plugin.json mcp_config.json server.mjs install.sh uninstall.sh install.ps1 LICENSE README.md README.zh-CN.md; do
    if [ -f "$SCRIPT_DIR/$f" ]; then
      cp -f "$SCRIPT_DIR/$f" "$PLUGIN_DST/$f"
    fi
  done

  for d in assets rules skills scripts; do
    if [ -d "$SCRIPT_DIR/$d" ]; then
      rm -rf "$PLUGIN_DST/$d"
      cp -R "$SCRIPT_DIR/$d" "$PLUGIN_DST/$d"
    fi
  done

  if [ -d "$SCRIPT_DIR/packs" ]; then
    mkdir -p "$PLUGIN_DST/packs"
    for pack_dir in "$SCRIPT_DIR/packs"/*; do
      [ -d "$pack_dir" ] || continue
      pack_name="$(basename "$pack_dir")"
      rm -rf "$PLUGIN_DST/packs/$pack_name"
      cp -R "$pack_dir" "$PLUGIN_DST/packs/$pack_name"
    done
  fi

  find "$PLUGIN_DST" -name ".DS_Store" -delete 2>/dev/null || true
  chmod +x "$PLUGIN_DST/install.sh" "$PLUGIN_DST/uninstall.sh" 2>/dev/null || true
else
  echo "[1/3] 已位于目标插件目录，跳过自复制: $PLUGIN_DST"
fi

# 2. 为已安装的 mcp_config.json 写入绝对 Node 路径（解决 macOS Dock GUI 找不到 fnm/nvm/Homebrew Node 的问题）
"$NODE_BIN" -e '
const fs = require("fs");
const path = require("path");
const cfgPath = process.argv[1];
const nodeBin = process.argv[2];
const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (!raw.mcpServers) raw.mcpServers = {};
const entry = raw.mcpServers["agy-meme"] || {};
entry.command = nodeBin;
if (!Array.isArray(entry.args) || entry.args.length === 0) {
  entry.args = ["${PLUGIN_ROOT}/server.mjs"];
}
raw.mcpServers["agy-meme"] = entry;
fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
' "$PLUGIN_DST/mcp_config.json" "$NODE_BIN"

# 初始化 ~/.gemini/meme-packs 与默认配置（幂等，不覆盖用户自定义图库/配置）
HOME="$TARGET_HOME" "$NODE_BIN" "$PLUGIN_DST/scripts/meme_patcher.js" --seed-only

if [ "${EUID:-$(id -u)}" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  chown -R "$SUDO_USER" "$TARGET_HOME/.gemini/config/plugins/agy-meme" "$TARGET_HOME/.gemini/meme-packs" 2>/dev/null || true
fi

# 3. 尝试通过官方 agy CLI 启用插件（失败时静默提示）
AGY_BIN="$(command -v agy 2>/dev/null || printf '%s' "$TARGET_HOME/.local/bin/agy")"
if [ -x "$AGY_BIN" ]; then
  echo "[2/3] 检查并启用 agy 插件注册..."
  if [ "${EUID:-$(id -u)}" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    su - "$SUDO_USER" -c "HOME='$TARGET_HOME' '$AGY_BIN' plugin enable agy-meme" >/dev/null 2>&1 || true
  else
    HOME="$TARGET_HOME" "$AGY_BIN" plugin enable agy-meme >/dev/null 2>&1 || true
  fi
else
  echo "[2/3] 未检测到 agy CLI，已跳过自动启用（安装插件后可在 Antigravity 插件面板开启）。"
fi

if [ "$PLUGIN_ONLY" -eq 1 ]; then
  echo "[3/3] 已指定 --plugin-only：跳过桌面端 ASAR 渲染器注入。"
  echo "[完成] MCP 插件与图库已就绪。若需启用气泡贴纸渲染与选图面板，请在系统独立终端执行："
  echo "       bash \"$PLUGIN_DST/install.sh\""
  exit 0
fi

# 4. 叠加注入桌面端渲染器与 IPC
echo "[3/3] 注入 Antigravity Desktop 猫娘表情包渲染器与 IPC..."
set +e
HOME="$TARGET_HOME" "$NODE_BIN" "$PLUGIN_DST/scripts/meme_patcher.js" --check-write "${PASSTHROUGH_ARGS[@]}"
WRITE_CHECK_RC=$?
set -e

if [ "$WRITE_CHECK_RC" -eq 0 ]; then
  HOME="$TARGET_HOME" "$NODE_BIN" "$PLUGIN_DST/scripts/meme_patcher.js" --install "${PASSTHROUGH_ARGS[@]}"
elif [ "$WRITE_CHECK_RC" -eq 2 ]; then
  echo "[权限] Antigravity 安装目录需要管理员权限，请输入密码以继续："
  sudo env "HOME=$TARGET_HOME" "PATH=$PATH" "$NODE_BIN" "$PLUGIN_DST/scripts/meme_patcher.js" --install "${PASSTHROUGH_ARGS[@]}"
elif [ "$WRITE_CHECK_RC" -eq 3 ]; then
  echo "[错误] 未找到 Antigravity Desktop 客户端。可使用 --install-dir <路径> 手动指定。" >&2
  exit 1
else
  echo "[错误] 写入权限检查失败 (退出码: $WRITE_CHECK_RC)" >&2
  exit "$WRITE_CHECK_RC"
fi

echo ""
echo "[全部完成] 请确认 Antigravity Desktop 已重启，并在 Plugins 面板启用 agy-meme。"
echo "          聊天输入框快捷键 Command+Shift+M / Ctrl+Shift+M 可呼出猫娘表情面板。"
