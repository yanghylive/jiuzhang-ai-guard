#!/usr/bin/env bash
# 同步 JIUZHANG AI 管家.app 到：workspace 项目 + 桌面（改动项目后执行，保持三处启动器一致）
# 自包含版：launcher 使用 app 内置 Resources/scripts，三处完全一致，无需注入路径
# 用法: bash scripts/sync-workdaddy-app.sh
set -uo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/JIUZHANG AI 管家.app"
if [ ! -d "$SRC" ]; then
  echo "错误: 未找到 $SRC"
  exit 1
fi

sync_workspace() {
  local dest="/Users/h/workspace/workbuddy-switch/JIUZHANG AI 管家.app"
  rm -rf "$dest" && cp -R "$SRC" "$dest" && chmod -R u+rwX "$dest"
  echo "已同步 -> $dest"
}

sync_desktop() {
  local dest="$HOME/Desktop/JIUZHANG AI 管家.app"
  rm -rf "$dest" && cp -R "$SRC" "$dest" && chmod -R u+rwX "$dest"
  bash -n "$dest/Contents/MacOS/launcher" || return 1
  echo "已同步 -> ${dest}（自包含）"
}

sync_workspace
sync_desktop
echo "完成"
