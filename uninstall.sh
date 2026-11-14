#!/usr/bin/env bash
set -euo pipefail

# agy-meme 卸载脚本（macOS / Linux）
# 默认仅无损剥离桌面端 Meme 注入块，完好保留 antigravity-desktop-cn 汉化与原版功能。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PATCHER="$SCRIPT_DIR/scripts/meme_patcher.js"

if [ ! -f "$PATCHER" ]; then
  echo "[错误] 未找到补丁脚本: $PATCHER" >&2
  exit 1
fi

PURGE_PLUGIN=0
PURGE_PACKS=0
PASSTHROUGH_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --restore-bak|--no-kill)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
    --install-dir)
      if [ $# -lt 2 ]; then
        echo "[错误] --install-dir 需要传入目录路径" >&2
        exit 1
      fi
      PASSTHROUGH_ARGS+=("--install-dir" "$2")
      shift 2
      ;;
    --install-dir=*)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
    --purge-plugin)
      PURGE_PLUGIN=1
      shift
      ;;
    --purge-packs)
      PURGE_PACKS=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./uninstall.sh [选项]

选项:
  --install-dir <path>    手动指定 Antigravity 安装目录（或沙箱测试目录）
  --no-kill               不自动关闭 / 重启正在运行的 Antigravity Desktop
  --restore-bak           从 app.asar.bak 整包还原（会同时还原其他 ASAR 补丁）
  --purge-plugin          同时卸载并删除 ~/.gemini/config/plugins/agy-meme
  --purge-packs           同时删除 ~/.gemini/meme-packs（包含自定义收录表情）
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
  local cand home_dir
  home_dir="$(resolve_target_user_home)"
  for cand in \
    "${AGY_MEME_NODE_BIN:-}" \
    "$(command -v node 2>/dev/null || true)" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node" \
    "$home_dir/.local/share/fnm/aliases/default/bin/node" \
    "$home_dir/.fnm/aliases/default/bin/node" \
    "$home_dir/.volta/bin/node" \
    "$home_dir/.nvm/versions/node"/*/bin/node \
    "$home_dir/.local/share/fnm/node-versions"/*/installation/bin/node; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node_bin || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[错误] 未找到 Node.js (需要 v18+)。" >&2
  exit 1
fi

TARGET_HOME="$(resolve_target_user_home)"
export PATH="$(cd "$(dirname "$NODE_BIN")" && pwd -P):$PATH"

set +e
HOME="$TARGET_HOME" "$NODE_BIN" "$PATCHER" --check-write "${PASSTHROUGH_ARGS[@]}"
WRITE_CHECK_RC=$?
set -e

if [ "$WRITE_CHECK_RC" -eq 0 ]; then
  HOME="$TARGET_HOME" "$NODE_BIN" "$PATCHER" --uninstall "${PASSTHROUGH_ARGS[@]}"
elif [ "$WRITE_CHECK_RC" -eq 2 ]; then
  echo "[权限] Antigravity 安装目录需要管理员权限，请输入密码以继续："
  sudo env "HOME=$TARGET_HOME" "PATH=$PATH" "$NODE_BIN" "$PATCHER" --uninstall "${PASSTHROUGH_ARGS[@]}"
elif [ "$WRITE_CHECK_RC" -eq 3 ]; then
  echo "[提示] 未检测到 Antigravity Desktop 安装目录，跳过 ASAR 剥离。"
else
  exit "$WRITE_CHECK_RC"
fi

if [ "$PURGE_PLUGIN" -eq 1 ]; then
  AGY_BIN="$(command -v agy 2>/dev/null || printf '%s' "$TARGET_HOME/.local/bin/agy")"
  if [ -x "$AGY_BIN" ]; then
    HOME="$TARGET_HOME" "$AGY_BIN" plugin disable agy-meme >/dev/null 2>&1 || true
  fi
  rm -rf "$TARGET_HOME/.gemini/config/plugins/agy-meme"
  echo "[清理] 已移除插件目录: $TARGET_HOME/.gemini/config/plugins/agy-meme"
fi

if [ "$PURGE_PACKS" -eq 1 ]; then
  rm -rf "$TARGET_HOME/.gemini/meme-packs"
  echo "[清理] 已移除本地表情包目录: $TARGET_HOME/.gemini/meme-packs"
fi

echo "[完成] agy-meme 卸载流程已完成。"
