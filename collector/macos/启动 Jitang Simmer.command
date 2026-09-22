#!/bin/zsh
# ============================================================
# 启动 Jitang Simmer（macOS）
#  聚合模式（collector-config.json 指向远端）：只启动采集代理，打开远程面板
#  本机模式（无配置）：启动本机后端 + 采集代理，打开本机面板
# ============================================================
set -u
DIST="$(cd "$(dirname "$0")" && pwd)"
cd "$DIST"
mkdir -p "$DIST/logs"
LOCAL_URL="http://127.0.0.1:8788"
CONFIG="$DIST/collector/macos/collector-config.json"

# ---- 读取采集端配置 ----
SERVER_URL=""
DASHBOARD_URL=""
if [ -f "$CONFIG" ]; then
  SERVER_URL="$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$CONFIG')).get('serverUrl',''))" 2>/dev/null || true)"
  DASHBOARD_URL="$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$CONFIG')).get('dashboardUrl',''))" 2>/dev/null || true)"
fi
AGGREGATED=0
case "$SERVER_URL" in
  ""|http://127.0.0.1*|http://localhost*) AGGREGATED=0 ;;
  *) AGGREGATED=1 ;;
esac

# ---- 定位 node（Finder 启动时 PATH 不含 Homebrew） ----
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
  echo "未找到 Node.js（需要 Node 24）。请先安装："
  echo "  brew install node@24     # 或访问 https://nodejs.org 下载 LTS"
  echo "按回车退出..."; read
  exit 1
fi
echo "使用 Node: $NODE_BIN ($("$NODE_BIN" --version))"

if [ "$AGGREGATED" = "1" ]; then
  echo "聚合模式：数据上报至 $SERVER_URL（不启动本机后端）"
else
  # ---- 本机模式：启动后端 ----
  if curl -s -o /dev/null --max-time 2 "$LOCAL_URL/api/devices"; then
    echo "本机后端已在运行"
  else
    echo "启动本机后端..."
    nohup "$NODE_BIN" "$DIST/server/index.js" >> "$DIST/logs/server.log" 2>&1 &
    echo $! > "$DIST/logs/server.pid"
    for _ in {1..30}; do
      curl -s -o /dev/null --max-time 2 "$LOCAL_URL/api/devices" && break
      sleep 1
    done
    curl -s -o /dev/null --max-time 2 "$LOCAL_URL/api/devices" \
      && echo "后端就绪：$LOCAL_URL" \
      || { echo "后端启动失败，请查看 logs/server.log"; tail -5 "$DIST/logs/server.log" 2>/dev/null; }
  fi
fi

# ---- 启动采集代理（软件时长 + Token + 硬件） ----
# 注意：LaunchAgent（开机自启）启动的实例不会写 logs/collector.pid，
# 因此必须按进程名检测，否则手动启动会起第二个实例、污染统计。
COLLECTOR_PID="$DIST/logs/collector.pid"
RUNNING_PID="$(pgrep -f "simmer-collector\.js" 2>/dev/null | head -1)"
if [ -n "$RUNNING_PID" ]; then
  echo "采集代理已在运行 (PID $RUNNING_PID)，不重复启动"
  echo "$RUNNING_PID" > "$COLLECTOR_PID"
elif [ -f "$COLLECTOR_PID" ] && kill -0 "$(cat "$COLLECTOR_PID")" 2>/dev/null; then
  echo "采集代理已在运行 (PID $(cat "$COLLECTOR_PID"))"
else
  echo "启动采集代理（软件使用时长 + AI Token + 硬件指标）..."
  nohup "$NODE_BIN" "$DIST/collector/macos/simmer-collector.js" \
    >> "$DIST/logs/collector.log" 2>&1 &
  echo $! > "$COLLECTOR_PID"
  echo "采集代理已启动 (PID $(cat "$COLLECTOR_PID"))，日志见 logs/collector.log"
fi

# ---- 打开面板 ----
if [ "$AGGREGATED" = "1" ] && [ -n "$DASHBOARD_URL" ]; then
  TARGET="$DASHBOARD_URL"
else
  TARGET="$LOCAL_URL/index.html"
fi
open "$TARGET"
osascript -e 'display notification "面板已打开，正在统计软件时长、Token 与硬件指标" with title "Jitang Simmer"' 2>/dev/null || true
echo ""
if [ "$AGGREGATED" = "1" ]; then
  echo "Jitang Simmer 已启动，数据聚合至：$SERVER_URL"
  echo "面板：$TARGET"
else
  echo "Jitang Simmer 已启动：$TARGET"
fi
echo "停止服务请双击「停止 Jitang Simmer.command」"
