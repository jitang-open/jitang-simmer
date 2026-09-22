#!/bin/zsh
# ============================================================
# autostart-run.sh · 开机自启由 launchd 调用
#  聚合模式：只跑采集代理（上报远端聚合服务器）
#  本机模式：先确保本机后端在运行，再前台跑采集代理
# 采集代理由 launchd KeepAlive 守护，异常退出会自动重启。
# ============================================================
set -u
DIST="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$DIST/logs"
LOCAL_URL="http://127.0.0.1:8788"
LOG="$DIST/logs/autostart.log"
CONFIG="$DIST/collector/macos/collector-config.json"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] autostart 启动" >> "$LOG"

# ---- 是否聚合模式 ----
SERVER_URL=""
[ -f "$CONFIG" ] && SERVER_URL="$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$CONFIG')).get('serverUrl',''))" 2>/dev/null || true)"
AGGREGATED=0
case "$SERVER_URL" in
  ""|http://127.0.0.1*|http://localhost*) AGGREGATED=0 ;;
  *) AGGREGATED=1 ;;
esac

# ---- 定位 node ----
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  # 注意：zsh 下无匹配的 glob 会直接报错退出，nvm 路径必须用 (N) 限定符
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node \
      "$HOME/.local/share/mise/shims/node" "$HOME/.volta/bin/node" \
      "$HOME"/.nvm/versions/node/*/bin/node(N); do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] 未找到 node，退出" >> "$LOG"
  exit 1
fi

# ---- 本机模式：确保后端在运行（独立于本进程） ----
if [ "$AGGREGATED" = "0" ]; then
  if ! curl -s -o /dev/null --max-time 2 "$LOCAL_URL/api/devices"; then
    nohup "$NODE_BIN" "$DIST/server/index.js" >> "$DIST/logs/server.log" 2>&1 &
    echo $! > "$DIST/logs/server.pid"
    for _ in {1..30}; do
      curl -s -o /dev/null --max-time 2 "$LOCAL_URL/api/devices" && break
      sleep 1
    done
  fi
fi

# ---- 采集代理（前台运行，交给 launchd 守护） ----
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) 启动采集代理（$([ "$AGGREGATED" = "1" ] && echo 聚合模式 || echo 本机模式)）" >> "$LOG"
exec "$NODE_BIN" "$DIST/collector/macos/simmer-collector.js"
