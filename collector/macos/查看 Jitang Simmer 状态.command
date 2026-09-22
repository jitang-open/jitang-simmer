#!/bin/zsh
# ============================================================
# 查看 Jitang Simmer 状态（macOS）
#  一条命令看清：开机自启是否生效、采集是否在跑、数据是否在上报
# ============================================================
set -u
DIST="$(cd "$(dirname "$0")" && pwd)"
LABEL="io.jitang.simmer.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG="$DIST/collector/macos/collector-config.json"
STATE_DIR="$HOME/Library/Application Support/SimmerCollector"
LOG="$STATE_DIR/mac-collector.log"

echo "=============================================="
echo " Jitang Simmer 运行状态"
echo "=============================================="

# ---- 上报配置 ----
if [ -f "$CONFIG" ]; then
  SERVER="$(/usr/bin/python3 -c "import json;print(json.load(open('$CONFIG')).get('serverUrl',''))" 2>/dev/null || true)"
  DASH="$(/usr/bin/python3 -c "import json;print(json.load(open('$CONFIG')).get('dashboardUrl',''))" 2>/dev/null || true)"
  case "$SERVER" in
    ""|http://127.0.0.1*|http://localhost*) MODE="本机模式" ;;
    *) MODE="聚合模式" ;;
  esac
  echo "运行模式 : $MODE"
  echo "上报地址 : ${SERVER:-（未配置）}"
  [ -n "$DASH" ] && echo "面板地址 : $DASH"
else
  echo "运行模式 : 本机模式（无 collector-config.json）"
fi
echo ""

# ---- 开机自启 ----
echo "---- 开机自启 ----"
if [ -f "$PLIST" ]; then
  echo "LaunchAgent : 已安装（$PLIST）"
  AGENT_STATE="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s+state = " | head -1 | sed 's/.*= //')"
  AGENT_PID="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s+pid = " | head -1 | sed 's/.*= //')"
  AGENT_RUNS="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s+runs = " | head -1 | sed 's/.*= //')"
  echo "当前状态   : ${AGENT_STATE:-未加载}${AGENT_PID:+（PID $AGENT_PID）}${AGENT_RUNS:+，本次登录已启动 $AGENT_RUNS 次}"
  if [ "${AGENT_STATE:-}" = "running" ]; then
    echo "结论       : ✅ 开机自启正常（登录后由 launchd 自动拉起）"
  else
    echo "结论       : ⚠️ 已安装但当前未运行；双击「安装开机自启.command」可重新加载"
  fi
else
  echo "LaunchAgent : 未安装"
  echo "结论       : ⚠️ 开机不会自启；双击「安装开机自启.command」启用"
fi
echo ""

# ---- 采集进程 ----
echo "---- 采集进程 ----"
COLLECTORS="$(pgrep -f "simmer-collector\.js" 2>/dev/null)"
COUNT="$(printf '%s\n' "$COLLECTORS" | grep -c . || true)"
if [ "${COUNT:-0}" -gt 0 ]; then
  printf '%s\n' "$COLLECTORS" | while read -r pid; do
    [ -z "$pid" ] && continue
    ETIME="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
    echo "采集代理 : PID $pid（已运行 $ETIME）"
  done
  [ "${COUNT:-0}" -gt 1 ] && echo "⚠️ 检测到 $COUNT 个采集代理实例（应只有 1 个），请双击「停止」后重新启动"
else
  echo "采集代理 : ❌ 未运行"
fi
for probe in simmer-fg-probe simmer-hw-probe; do
  PPID_="$(pgrep -f "$probe" 2>/dev/null | head -1)"
  [ -n "$PPID_" ] && echo "$probe : PID $PPID_" || echo "$probe : 未运行"
done
echo ""

# ---- 最近上报 ----
echo "---- 最近上报（来自采集日志）----"
if [ -f "$LOG" ]; then
  LAST="$(grep -E "上报成功|心跳已发送" "$LOG" 2>/dev/null | tail -3)"
  if [ -n "$LAST" ]; then
    printf '%s\n' "$LAST" | sed 's/^/  /'
  else
    echo "  （暂无上报记录）"
  fi
  echo "  日志文件 : $LOG"
else
  echo "  （尚未生成日志）"
fi
echo ""

# ---- 待上报队列 ----
echo "---- 待上报队列 ----"
for q in usage-queue hardware-queue; do
  F="$STATE_DIR/$q.json"
  if [ -f "$F" ]; then
    N="$(/usr/bin/python3 -c "import json;print(len(json.load(open('$F'))))" 2>/dev/null || echo '?')"
    echo "  $q : $N 条"
  fi
done
echo ""
echo "提示：开机自启的实例在后台静默运行（无界面）。"
echo "      要停止请双击「停止 Jitang Simmer.command」。"
