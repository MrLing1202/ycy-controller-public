#!/usr/bin/env python3
"""
YCY Audio Reactive Controller
=============================

一个独立的 Web Bluetooth 控制面板：
- 通过浏览器 Web Bluetooth 直连 BLE 设备
- 手动调整 A/B/C 三通道速度与模式
- 读取本地视频/音频或屏幕共享音频，根据响度实时映射为强度

运行：
    py run.py
然后打开：
    http://localhost:8080
"""

from __future__ import annotations

import os
import shutil
import socket
import webbrowser
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template

BASE_DIR = Path(__file__).resolve().parent
os.chdir(BASE_DIR)

if not (BASE_DIR / ".env").exists() and (BASE_DIR / ".env.example").exists():
    shutil.copyfile(BASE_DIR / ".env.example", BASE_DIR / ".env")

load_dotenv(BASE_DIR / ".env")

app = Flask(__name__, template_folder="templates", static_folder="static")


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip() or default


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config")
def api_config():
    return jsonify(
        {
            "service_uuid": _env("BLE_SERVICE_UUID", "0000ff40-0000-1000-8000-00805f9b34fb"),
            "write_uuid": _env("BLE_WRITE_UUID", "0000ff41-0000-1000-8000-00805f9b34fb"),
            "notify_uuid": _env("BLE_NOTIFY_UUID", "0000ff42-0000-1000-8000-00805f9b34fb"),
            "device_name": _env("BLE_DEVICE_NAME", "YCY-FJB-03"),
        }
    )


@app.route("/api/health")
def api_health():
    return jsonify({"ok": True, "app": "YCY Audio Reactive Controller"})


def _can_bind(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main():
    host = _env("HOST", "127.0.0.1")
    port = int(_env("PORT", "8080"))
    if not _can_bind(host, port):
        raise SystemExit(f"端口 {port} 已被占用，请修改 .env 里的 PORT 或关闭旧程序。")

    url = f"http://{host}:{port}"
    print("=" * 60)
    print("YCY Audio Reactive Controller")
    print(f"打开浏览器：{url}")
    print("提示：Web Bluetooth 需要 Chrome / Edge，并且页面必须是 localhost 或 HTTPS。")
    print("=" * 60)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    app.run(host=host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
