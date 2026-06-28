#!/bin/bash
# YCY Controller 24h 守护脚本
# 自动重启服务和隧道，防掉线

cd ~/ycy-controller
mkdir -p logs

LOG="logs/daemon.log"

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

start_server() {
    pkill -f "run.py" 2>/dev/null; sleep 1
    nohup .venv/bin/python run.py > logs/server.log 2>&1 &
    echo $! > logs/server.pid
    log "服务启动 PID=$(cat logs/server.pid)"
}

start_tunnel() {
    pkill -f localhost.run 2>/dev/null; sleep 1
    nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 80:localhost:8080 nokey@localhost.run > logs/tunnel.log 2>&1 &
    echo $! > logs/tunnel.pid
    log "隧道启动 PID=$(cat logs/tunnel.pid)"
    # 等URL
    for i in $(seq 1 30); do
        sleep 1
        URL=$(grep -oE "https://[a-z0-9]+\.lhr\.life" logs/tunnel.log | head -1)
        if [ -n "$URL" ]; then
            echo "$URL" > logs/tunnel-url.txt
            log "URL: $URL"
            return 0
        fi
    done
    log "URL获取超时"
    return 1
}

check_server() {
    local pid=$(cat logs/server.pid 2>/dev/null)
    if ! kill -0 "$pid" 2>/dev/null; then
        log "服务挂了，重启..."
        start_server
        return 1
    fi
    # 检查HTTP响应
    local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8080 2>/dev/null)
    if [ "$code" != "200" ]; then
        log "服务无响应($code)，重启..."
        start_server
        return 1
    fi
    return 0
}

check_tunnel() {
    local pid=$(cat logs/tunnel.pid 2>/dev/null)
    if ! kill -0 "$pid" 2>/dev/null; then
        log "隧道挂了，重启..."
        start_tunnel
        return 1
    fi
    # 检查隧道URL是否还活着
    local url=$(cat logs/tunnel-url.txt 2>/dev/null)
    if [ -n "$url" ] && [ "$url" != "http://192.168.1.15:8080" ]; then
        local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)
        if [ "$code" = "000" ] || [ "$code" = "530" ] || [ "$code" = "1033" ]; then
            log "隧道URL不可用($code)，重启..."
            start_tunnel
            return 1
        fi
    fi
    return 0
}

# ─── 主流程 ──────────────────────────────────────────
log "=== 守护脚本启动 ==="
start_server
sleep 2
start_tunnel

while true; do
    sleep 120
    check_server
    check_tunnel
done
