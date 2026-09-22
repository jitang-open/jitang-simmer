#!/bin/zsh
# 停止 Jitang Simmer 后端与采集代理（macOS）
set -u
DIST="$(cd "$(dirname "$0")" && pwd)"

for name in collector server; do
  PID_FILE="$DIST/logs/$name.pid"
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "已停止 $name (PID $pid)"
    else
      echo "$name 未在运行"
    fi
    rm -f "$PID_FILE"
  else
    echo "$name 未在运行"
  fi
done

# 兜底：清理残留的采集代理与占用 8788 端口的 simmer 后端进程
pkill -f "simmer-collector.js" 2>/dev/null && echo "已清理残留采集代理"
pkill -f "simmer-fg-probe" 2>/dev/null && echo "已清理残留前台探针"
extra="$(lsof -ti :8788 2>/dev/null || true)"
if [ -n "$extra" ]; then
  kill $extra 2>/dev/null && echo "已停止占用 8788 端口的进程：$extra"
fi
osascript -e 'display notification "后端与采集代理已停止" with title "Jitang Simmer"' 2>/dev/null || true
echo "完成"
