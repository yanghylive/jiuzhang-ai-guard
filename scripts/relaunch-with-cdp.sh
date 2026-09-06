#!/usr/bin/env bash
# 一键修复/启用 CDP 模式（仅手动启动 daemon，不注册登录自启）：
#   1) 清理旧的 launchd 注册并手动启动守护进程
#   2) 彻底退出 WorkBuddy（注意：其进程名是 Electron，不能按 "WorkBuddy" 杀）
#   3) 带 --remote-debugging-port 直接执行应用二进制启动（保证参数生效）
#   4) 验证 CDP 端口开放
#
# 交互式菜单：
#   1) 启动/重启 WorkBuddy 并启用 CDP（默认）
#   2) 恢复登录：从本地备份选择一个账号写入登录文件，再启动 WorkBuddy
#   3) 退出
#
# 用法: bash scripts/relaunch-with-cdp.sh [CDP端口，默认自动选择 9222-9232/9333]
set -uo pipefail

PORT="${WBSWITCH_CDP_PORT:-${1:-}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${WBSWITCH_PROFILE:-workbuddy-cn}"
case "$PROFILE" in
  workbuddy-ai) APP_NAME="WorkBuddy AI"; APP_BIN="/Applications/WorkBuddy AI.app/Contents/MacOS/Electron"; DEFAULT_DATA_DIR="$HOME/Library/Application Support/JiuZhangAI/profiles/workbuddy-ai"; DEFAULT_UI_PORT=47833; DEFAULT_CDP_PORT=9223; AUTH_DEFAULT="$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info" ;;
  codebuddy-cn) APP_NAME="CodeBuddy CN"; APP_BIN="/Applications/CodeBuddy CN.app/Contents/MacOS/Electron"; DEFAULT_DATA_DIR="$HOME/Library/Application Support/JiuZhangAI/profiles/codebuddy-cn"; DEFAULT_UI_PORT=47834; DEFAULT_CDP_PORT=9224; AUTH_DEFAULT="" ;;
  codebuddy-intl) APP_NAME="CodeBuddy"; APP_BIN="/Applications/CodeBuddy.app/Contents/MacOS/Electron"; DEFAULT_DATA_DIR="$HOME/Library/Application Support/JiuZhangAI/profiles/codebuddy-intl"; DEFAULT_UI_PORT=47835; DEFAULT_CDP_PORT=9225; AUTH_DEFAULT="" ;;
  *) PROFILE="workbuddy-cn"; APP_NAME="WorkBuddy"; APP_BIN="/Applications/WorkBuddy.app/Contents/MacOS/Electron"; DEFAULT_DATA_DIR="$HOME/Library/Application Support/JiuZhangAI"; DEFAULT_UI_PORT=47832; DEFAULT_CDP_PORT=9222; AUTH_DEFAULT="$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info" ;;
esac
export WBSWITCH_PROFILE="$PROFILE"
if [ -z "$PORT" ]; then PORT="$DEFAULT_CDP_PORT"; fi
LABEL="com.workbuddy.workdaddy.${PROFILE}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABEL="com.workbuddy.hellobuddy"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
LEGACY_DATA_DIR="$HOME/Library/Application Support/HelloBuddy"
if [ "${WBSWITCH_DATA_DIR:-}" = "$LEGACY_DATA_DIR" ]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
else
  DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
fi
UI_PORT="${WBSWITCH_PORT:-$DEFAULT_UI_PORT}"
AUTH_FILE="${WBSWITCH_AUTH_FILE:-$AUTH_DEFAULT}"
CDP_PORT_FILE="$DATA_DIR/cdp-port.json"

# 统一使用的 node 路径（优先系统 PATH，兜底用 managed runtime）
NODE_BIN="$(command -v node || echo /Users/h/.workbuddy/binaries/node/versions/22.22.2/bin/node)"
REPORTER="$DIR/scripts/sentry-report.js"
report_relaunch_failure() {
  local code="$1"
  if [ -f "$REPORTER" ] && [ -x "$NODE_BIN" ]; then
    "$NODE_BIN" "$REPORTER" --stage macos-relaunch --message "relaunch-with-cdp.sh 失败 (exit=${code})" --extra-json "{\"exitCode\":${code}}" >/dev/null 2>&1 || true
  fi
}
on_relaunch_exit() {
  local code="$?"
  if [ "$code" -ne 0 ]; then report_relaunch_failure "$code"; fi
  return "$code"
}
trap on_relaunch_exit EXIT

valid_port() { [ "${1:-0}" -ge 1024 ] 2>/dev/null && [ "${1:-0}" -le 65535 ] 2>/dev/null; }
port_in_use() {
  if command -v nc >/dev/null 2>&1; then nc -z -w 1 127.0.0.1 "$1" >/dev/null 2>&1; else curl -s --max-time 1 "http://127.0.0.1:$1/" >/dev/null 2>&1; fi
}
is_workbuddy_cdp() { curl -fsS --max-time 1 "http://127.0.0.1:$1/json/version" 2>/dev/null | grep -qiE 'WorkBuddy|CodeBuddy'; }
resolve_cdp_port() {
  local saved="" p
  if [ -f "$CDP_PORT_FILE" ]; then saved="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CDP_PORT_FILE" | head -1)"; fi
  local candidates=""
  valid_port "$PORT" && candidates="$candidates $PORT"
  valid_port "$saved" && candidates="$candidates $saved"
  for p in $(seq 9222 9232); do candidates="$candidates $p"; done
  candidates="$candidates 9333"
  for p in $candidates; do
    if is_workbuddy_cdp "$p"; then PORT="$p"; break; fi
  done
  if ! is_workbuddy_cdp "$PORT"; then
    for p in $candidates; do if ! port_in_use "$p"; then PORT="$p"; break; fi; done
  fi
  if ! valid_port "$PORT"; then echo "错误：9222-9232、9333 均被占用，无法启动 CDP"; exit 1; fi
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  printf '{"port":%s,"updatedAt":"%s"}\n' "$PORT" "$(date -u +%FT%TZ)" > "${CDP_PORT_FILE}.tmp.$$" 2>/dev/null || true
  mv -f "${CDP_PORT_FILE}.tmp.$$" "$CDP_PORT_FILE" 2>/dev/null || true
}
resolve_cdp_port

# 清理旧版常驻服务和旧 profile 自启项，但保留账号数据；daemon 仅由本次手动执行启动。
for old_profile in workbuddy-cn workbuddy-ai codebuddy-cn codebuddy-intl; do
  old_label="com.workbuddy.workdaddy.${old_profile}"
  old_plist="$HOME/Library/LaunchAgents/${old_label}.plist"
  launchctl bootout "gui/$(id -u)" "$old_plist" 2>/dev/null || true
  launchctl remove "$old_label" 2>/dev/null || true
  rm -f "$old_plist"
done
launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LEGACY_PLIST"
"$NODE_BIN" -e "const lib = require(process.argv[1]); const r = lib.migrateLegacyDataDir(process.argv[2]); if (r.migrated) console.log('已迁移 ' + r.migrated + ' 个旧版账号备份');" "$DIR/scripts/lib.js" "$DATA_DIR" 2>/dev/null || true

# ---------- 功能函数（必须先于调用定义） ----------

restore_login() {
  local accounts_dir="$DATA_DIR/accounts"
  echo ""
  echo "==> 扫描本地账号备份 ..."
  if [ ! -d "$accounts_dir" ]; then
    echo "   未找到备份目录: $accounts_dir"
    exit 1
  fi

  local map
  map=$("$NODE_BIN" -e "
    const fs = require('fs'), path = require('path');
    const dir = process.argv[1];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.info') && !f.endsWith('.tmp'));
    if (!files.length) { console.error('NO_ACCOUNTS'); process.exit(1); }
    files.forEach((f, i) => {
      const uid = f.replace(/\\.info$/, '');
      let nickname = '', phone = '';
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
        if (acct) { nickname = acct.nickname || ''; phone = acct.phoneNumber || ''; }
      } catch (_) {}
      console.log(\`\${i + 1}|\${uid}|\${nickname}|\${phone}\`);
    });
  " "$accounts_dir")

  if [ -z "$map" ]; then
    echo "   没有可用的账号备份"
    exit 1
  fi

  echo ""
  echo "可选账号："
  echo "$map" | while IFS='|' read -r idx uid nickname phone; do
    printf '  %s) %-12s  %-13s  UID:%s\n' "$idx" "${nickname:-(未命名)}" "${phone:-(-)}" "$uid"
  done
  echo ""

  read -r -p "选择要恢复的账号编号: " n
  local line
  line=$(echo "$map" | grep "^${n}|" || true)
  if [ -z "$line" ]; then
    echo "   无效编号"
    exit 1
  fi

  local uid
  uid=$(echo "$line" | cut -d'|' -f2)
  local src="$accounts_dir/${uid}.info"
  if [ ! -f "$src" ]; then
    echo "   备份文件不存在: $src"
    exit 1
  fi

  cp "$src" "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  echo "   已恢复账号 $uid 到登录文件"

  launch_plugin
}

launch_plugin() {
  echo ""
  echo "警告：即将退出 WorkBuddy 并以 CDP 模式重启（请先保存工作内容，包括当前对话）。"
  read -r -p "确认继续？(y/N) " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "已取消"; exit 0 ;;
  esac

  # ---------- 1. 手动启动 daemon（不注册 launchd，避免多个 profile 登录自启） ----------
  if ! curl -s -m 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then
    echo "==> 手动启动 WorkDaddy 守护进程"
    mkdir -p "$DATA_DIR/accounts"
    WBSWITCH_PROFILE="$PROFILE" WBSWITCH_DATA_DIR="$DATA_DIR" WBSWITCH_PORT="$UI_PORT" nohup "$NODE_BIN" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
    disown 2>/dev/null || true
  else
    echo "==> WorkDaddy 守护进程已运行，跳过启动"
  fi

  # 等待守护进程就绪
  for i in $(seq 1 10); do
    curl -s -m 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1 && { echo "==> 守护进程运行中"; break; }
    sleep 1
  done

  # ---------- 2. 彻底退出 WorkBuddy ----------
  echo "==> 退出 WorkBuddy ..."
  osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
  sleep 3
  # 兜底：按真实进程路径精确清理（进程名是 Electron，切勿 killall Electron 以免误伤其他应用）
  pkill -f "$APP_BIN" 2>/dev/null || true
  sleep 2
  if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
    echo "   警告：WorkBuddy 仍在运行，强制结束"
    pkill -9 -f "$APP_BIN" 2>/dev/null || true
    sleep 2
  fi

  # ---------- 3. 带调试端口启动 ----------
  echo "==> 以 --remote-debugging-port=${PORT} 启动 WorkBuddy"
  if [ ! -x "$APP_BIN" ]; then
    echo "   错误：未找到 $APP_BIN"
    exit 1
  fi
  nohup "$APP_BIN" --remote-debugging-port="$PORT" >/dev/null 2>&1 &
  disown 2>/dev/null || true

  # ---------- 4. 验证 ----------
  echo "==> 等待 CDP 端口开放"
  OK=0
  for i in $(seq 1 15); do
    sleep 1
    if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" | grep -qiE 'WorkBuddy|CodeBuddy'; then
      OK=1
      break
    fi
  done

  if [ "$OK" = "1" ]; then
    echo ""
    echo "CDP 已开启: http://127.0.0.1:${PORT}"
    echo "   WorkBuddy 启动后右下角会自动出现账号切换组件（约几秒内）。"
    echo "   若未出现，可手动重新注入（需带 API token，P1-6 修复后无 token 拒绝）:"
    echo "   curl -X POST -H \"x-jiuzhangai-token: \$(cat \"$DATA_DIR/.api-token\")\" http://127.0.0.1:47832/api/inject"
  else
    echo ""
    echo "警告：等待 15 秒仍未检测到 WorkBuddy CDP 端口 ${PORT}。"
    echo "   WorkBuddy 可能忽略了该参数，或启动较慢。可再等几秒后执行："
    echo "   curl http://127.0.0.1:${PORT}/json/version"
    "$NODE_BIN" "$REPORTER" --stage macos-cdp-timeout --message "等待 15 秒未检测到 WorkBuddy CDP 端口" --extra-json "{\"cdpPort\":${PORT}}" >/dev/null 2>&1 || true
  fi
}

# ---------- 交互式菜单（函数已定义，可安全调用） ----------

echo ""
echo "WorkBuddy 多账号切换器"
echo "  1) 启动/重启 WorkBuddy 并启用 CDP（默认）"
echo "  2) 恢复登录：从本地备份选择一个账号写入登录文件，再启动 WorkBuddy"
echo "  3) 退出"
read -r -p "请输入选项 [1]: " CHOICE
CHOICE="${CHOICE:-1}"

case "$CHOICE" in
  2)
    restore_login
    ;;
  3)
    echo "已取消"
    exit 0
    ;;
  *)
    launch_plugin
    ;;
esac
