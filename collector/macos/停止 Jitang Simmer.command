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
# 注意：pkill -f 会匹配整条命令行，可能误杀“命令行里含该字符串”的无关进程
# （例如正在查看日志的终端）。这里用锁文件里的 pid，探针用 -x 精确匹配进程名。
LOCK="$HOME/Library/Application Support/SimmerCollector/collector.lock"
if [ -f "$LOCK" ]; then
  LOCK_PID="$(/usr/bin/python3 -c "import json;print(json.load(open('$LOCK')).get('pid',''))" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    kill "$LOCK_PID" 2>/dev/null && echo "已清理残留采集代理 (PID $LOCK_PID)"
  fi
fi
pkill -x simmer-fg-probe 2>/dev/null && echo "已清理残留前台探针"
extra="$(lsof -ti :8788 2>/dev/null || true)"
if [ -n "$extra" ]; then
  kill $extra 2>/dev/null && echo "已停止占用 8788 端口的进程：$extra"
fi
osascript -e 'display notification "后端与采集代理已停止" with title "Jitang Simmer"' 2>/dev/null || true
echo "完成"
