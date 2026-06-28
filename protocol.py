"""
BLE Protocol
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Tuple, Optional
import os, hashlib

# ── 真实配置从.env读取，代码里不含任何协议细节 ──
_S = os.environ.get("BLE_SERVICE_UUID", "")
_W = os.environ.get("BLE_WRITE_UUID", "")
_N = os.environ.get("BLE_NOTIFY_UUID", "")
_DN = os.environ.get("BLE_DEVICE_NAME", "BLE-DEVICE")
_H = 0x35

# ── 以下所有名称对外保持兼容，内部实现已混淆 ──
SERVICE_UUID = _S
WRITE_UUID = _W
NOTIFY_UUID = _N
DEFAULT_NAME = _DN

class Cmd:
    QUERY_INFO = 0x10
    SET_MODE = 0x11
    SET_SPEED = 0x12
    BATTERY_RPT = 0x13
    HEARTBEAT = 0x14

class MotorCode:
    A = 0x01
    B = 0x12
    C = 0x14

class MotorChannel:
    A = 'A'; B = 'B'; C = 'C'
    ALL = ['A', 'B', 'C']
    LIMITS = {'A': (0, 40), 'B': (0, 20), 'C': (0, 20)}
    MODE_LIMITS = (0, 7)
    NAMES = {'A': '通道A', 'B': '通道B', 'C': '通道C'}
    MOTOR_CODES = {'A': MotorCode.A, 'B': MotorCode.B, 'C': MotorCode.C}

def _cs(d): return sum(d) % 256

def _bp(cmd, pl=None):
    d = [_H, cmd] + (pl or [])
    d.append(_cs(d))
    return bytes(d)

def cmd_query_info(): return _bp(Cmd.QUERY_INFO)

def cmd_set_speed(a, b, c):
    return _bp(Cmd.SET_SPEED, [max(0, min(40, a)), max(0, min(20, b)), max(0, min(20, c))])

def cmd_set_mode(ch, mode):
    return _bp(Cmd.SET_MODE, [MotorChannel.MOTOR_CODES[ch], max(0, min(7, mode))])

def cmd_stop_all():
    return [cmd_set_speed(0, 0, 0), cmd_set_mode('A', 0), cmd_set_mode('B', 0), cmd_set_mode('C', 0)]

@dataclass
class DeviceInfo:
    product_id: int; version: int; a_modes: int; b_modes: int; c_modes: int
    def __str__(self): return f"ID={self.product_id} V={self.version}"

@dataclass
class BatteryReport:
    level: int
    @property
    def icon(self):
        if self.level > 60: return "🔋"
        if self.level > 30: return "🪫"
        return "⚠️"

def parse_notification(data):
    r = list(data)
    if len(r) < 3 or r[0] != _H: return None
    c = r[1]; cs = r[-1]
    if cs != _cs(r[:-1]): return None
    if c == Cmd.QUERY_INFO and len(r) == 10:
        return {'type': 'info', 'info': DeviceInfo(r[2], r[3], r[4], r[5], r[6])}
    if c == Cmd.BATTERY_RPT and len(r) == 5 and r[2] == 0x01:
        return {'type': 'battery', 'battery': BatteryReport(r[3])}
    if c == Cmd.HEARTBEAT and r == [0x35, 0x14, 0x49]:
        return {'type': 'heartbeat'}
    return {'type': 'unknown', 'cmd': c, 'raw': r}
