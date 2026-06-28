"""
YCY-FJB BLE Protocol — 逆向工程提取的完整协议定义
=====================================================

设备通信基于 BLE GATT:
  Service:  0000ff40-0000-1000-8000-00805f9b34fb
  Write:    0000ff41-0000-1000-8000-00805f9b34fb  (host → device)
  Notify:   0000ff42-0000-1000-8000-00805f9b34fb  (device → host)

所有包格式: [0x35, CMD, ...DATA..., CHECKSUM]
校验: sum(所有非校验字节) % 256
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import IntEnum
from typing import Dict, Tuple, Optional
import struct

# ─── BLE UUIDs ─────────────────────────────────────────────
SERVICE_UUID  = "0000ff40-0000-1000-8000-00805f9b34fb"
WRITE_UUID    = "0000ff41-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID   = "0000ff42-0000-1000-8000-00805f9b34fb"

# ─── 协议常量 ──────────────────────────────────────────────
HEADER        = 0x35
DEFAULT_NAME  = "YCY-FJB-03"


class Cmd(IntEnum):
    """命令码"""
    QUERY_INFO    = 0x10   # 查询设备信息
    SET_MODE      = 0x11   # 设置内建模式
    SET_SPEED     = 0x12   # 设置速率
    BATTERY_RPT   = 0x13   # 电量上报 (设备→主机)
    HEARTBEAT     = 0x14   # 心跳 (设备→主机)


class MotorCode(IntEnum):
    """马达通道代码 (用于 SET_MODE 命令)"""
    A = 0x01   # 旋转伸缩
    B = 0x12   # 吮吸
    C = 0x14   # 震动


class MotorChannel:
    """通道标识"""
    A = 'A'   # 旋转伸缩: 速率 0-40 (0=停, 1-20正转, 21-40反转)
    B = 'B'   # 吮吸:     速率 0-20 (0=放气, 1=不动, 2-20=吸气)
    C = 'C'   # 震动:     速率 0-20

    ALL = ['A', 'B', 'C']

    LIMITS = {
        'A': (0, 40),
        'B': (0, 20),
        'C': (0, 20),
    }

    MODE_LIMITS = (0, 7)

    NAMES = {
        'A': '旋转伸缩',
        'B': '吮吸',
        'C': '震动',
    }

    MOTOR_CODES = {
        'A': MotorCode.A,
        'B': MotorCode.B,
        'C': MotorCode.C,
    }


def checksum(data: list[int]) -> int:
    """计算校验和: 所有字节之和 mod 256"""
    return sum(data) % 256


def build_packet(cmd: int, payload: list[int] = None) -> bytes:
    """构建发送包"""
    data = [HEADER, cmd] + (payload or [])
    data.append(checksum(data))
    return bytes(data)


# ─── 发送命令构建 ──────────────────────────────────────────

def cmd_query_info() -> bytes:
    """查询设备信息: [35 10 CS]"""
    return build_packet(Cmd.QUERY_INFO)


def cmd_set_speed(a: int, b: int, c: int) -> bytes:
    """
    设置速率: [35 12 A B C CS]
    A: 0-40, B: 0-20, C: 0-20
    """
    a = max(0, min(40, a))
    b = max(0, min(20, b))
    c = max(0, min(20, c))
    return build_packet(Cmd.SET_SPEED, [a, b, c])


def cmd_set_mode(channel: str, mode: int) -> bytes:
    """
    设置内建模式: [35 11 MOTOR_CODE MODE CS]
    mode: 0-7 (0=关闭)
    """
    mode = max(0, min(7, mode))
    motor_code = MotorChannel.MOTOR_CODES[channel]
    return build_packet(Cmd.SET_MODE, [motor_code, mode])


def cmd_stop_all() -> list[bytes]:
    """停止所有马达 — 返回多个命令包"""
    return [
        cmd_set_speed(0, 0, 0),
        cmd_set_mode('A', 0),
        cmd_set_mode('B', 0),
        cmd_set_mode('C', 0),
    ]


# ─── 接收数据解析 ──────────────────────────────────────────

@dataclass
class DeviceInfo:
    product_id: int
    version: int
    a_modes: int
    b_modes: int
    c_modes: int

    def __str__(self):
        return (f"产品ID={self.product_id} 版本={self.version} "
                f"A模式={self.a_modes} B模式={self.b_modes} C模式={self.c_modes}")


@dataclass
class BatteryReport:
    level: int  # 0-100%

    @property
    def icon(self) -> str:
        if self.level > 60: return "🔋"
        if self.level > 30: return "🪫"
        return "⚠️"


def parse_notification(data: bytes) -> dict | None:
    """
    解析设备通知数据
    返回: {'type': 'info'|'battery'|'heartbeat', ...} 或 None
    """
    raw = list(data)
    if len(raw) < 3 or raw[0] != HEADER:
        return None

    cmd = raw[1]
    cs = raw[-1]
    if cs != checksum(raw[:-1]):
        return None  # 校验失败

    if cmd == Cmd.QUERY_INFO and len(raw) == 10:
        return {
            'type': 'info',
            'info': DeviceInfo(raw[2], raw[3], raw[4], raw[5], raw[6])
        }

    if cmd == Cmd.BATTERY_RPT and len(raw) == 5 and raw[2] == 0x01:
        return {
            'type': 'battery',
            'battery': BatteryReport(raw[3])
        }

    if cmd == Cmd.HEARTBEAT and raw == [0x35, 0x14, 0x49]:
        return {'type': 'heartbeat'}

    return {'type': 'unknown', 'cmd': cmd, 'raw': raw}
