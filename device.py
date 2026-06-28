

from __future__ import annotations
import asyncio
import logging
import time
from typing import Callable, Optional, Dict, List
from dataclasses import dataclass, field

from bleak import BleakScanner, BleakClient

from protocol import (
    SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, DEFAULT_NAME,
    MotorChannel,
    cmd_query_info, cmd_set_speed, cmd_set_mode, cmd_stop_all,
    parse_notification, DeviceInfo, BatteryReport,
)

logger = logging.getLogger("ycy.device")

@dataclass
class DeviceState:
    
    connected: bool = False
    device_info: Optional[DeviceInfo] = None
    battery: Optional[BatteryReport] = None
    battery_level: int = -1
    speeds: Dict[str, int] = field(default_factory=lambda: {'A': 0, 'B': 0, 'C': 0})
    modes: Dict[str, int] = field(default_factory=lambda: {'A': 0, 'B': 0, 'C': 0})
    last_heartbeat: float = 0

class YCYDevice:
    

    def __init__(self, name: str = DEFAULT_NAME, on_battery: Callable = None,
                 on_disconnect: Callable = None):
        self.name = name
        self.client: Optional[BleakClient] = None
        self.state = DeviceState()
        self._on_battery = on_battery
        self._on_disconnect = on_disconnect
        self._notify_callbacks: List[Callable] = []

    async def scan(self, timeout: float = 10.0) -> list:
        
        devices = await BleakScanner.discover(timeout=timeout)
        return [(d.name or "未知", d.address, d) for d in devices]

    async def connect(self, timeout: float = 15.0) -> bool:
        
        logger.info(f"正在扫描设备 [{self.name}] ...")
        devices = await BleakScanner.discover(timeout=timeout)

        target = None
        for d in devices:
            if d.name and self.name in d.name:
                target = d
                break

        if not target:
            logger.warning(f"未找到设备 [{self.name}]")
            return False

        logger.info(f"找到设备: {target.name} ({target.address})，正在连接...")
        self.client = BleakClient(target, disconnected_callback=self._handle_disconnect)
        await self.client.connect()

        if not self.client.is_connected:
            logger.error("连接失败")
            return False

        await self.client.start_notify(NOTIFY_UUID, self._handle_notify)
        self.state.connected = True
        logger.info("已连接，通知通道已开启")

        await self.query_info()
        return True

    async def disconnect(self):
        
        if self.client and self.client.is_connected:
            try:
                for pkt in cmd_stop_all():
                    await self._write(pkt)
                    await asyncio.sleep(0.05)
            except Exception:
                pass
            await self.client.disconnect()
        self.state.connected = False
        logger.info("已断开连接")

    def _handle_disconnect(self, client):
        
        self.state.connected = False
        logger.warning("设备连接已断开")
        if self._on_disconnect:
            self._on_disconnect()

    def _handle_notify(self, sender, data):
        
        result = parse_notification(data)
        if not result:
            return

        msg_type = result['type']

        if msg_type == 'info':
            self.state.device_info = result['info']
            logger.info(f"设备信息: {result['info']}")

        elif msg_type == 'battery':
            self.state.battery = result['battery']
            self.state.battery_level = result['battery'].level
            logger.debug(f"电量: {result['battery'].level}%")
            if self._on_battery:
                self._on_battery(result['battery'].level)

        elif msg_type == 'heartbeat':
            self.state.last_heartbeat = time.time()

        for cb in self._notify_callbacks:
            try:
                cb(result)
            except Exception:
                pass

    def on_notify(self, callback: Callable):
        
        self._notify_callbacks.append(callback)

    async def query_info(self) -> Optional[DeviceInfo]:
        
        await self._write(cmd_query_info())
        await asyncio.sleep(1)
        return self.state.device_info

    async def set_speed(self, a: int = None, b: int = None, c: int = None):
        
        ca = a if a is not None else self.state.speeds['A']
        cb = b if b is not None else self.state.speeds['B']
        cc = c if c is not None else self.state.speeds['C']

        self.state.speeds = {'A': ca, 'B': cb, 'C': cc}
        for ch in MotorChannel.ALL:
            if locals().get(ch.lower()) is not None:
                self.state.modes[ch] = 0

        await self._write(cmd_set_speed(ca, cb, cc))
        logger.info(f"速率 → A={ca} B={cb} C={cc}")

    async def set_mode(self, channel: str, mode: int):
        
        channel = channel.upper()
        if channel not in MotorChannel.ALL:
            raise ValueError(f"无效通道: {channel}")

        self.state.modes[channel] = mode
        self.state.speeds[channel] = 0

        await self._write(cmd_set_mode(channel, mode))
        logger.info(f"模式 → {channel}={mode}")

    async def stop(self, channels: list[str] = None):
        
        chs = channels or MotorChannel.ALL
        for ch in chs:
            if self.state.speeds.get(ch, 0) != 0:
                await self.set_speed(**{ch.lower(): 0})
            if self.state.modes.get(ch, 0) != 0:
                await self.set_mode(ch, 0)

    async def emergency_stop(self):
        
        for pkt in cmd_stop_all():
            await self._write(pkt)
            await asyncio.sleep(0.03)
        self.state.speeds = {'A': 0, 'B': 0, 'C': 0}
        self.state.modes = {'A': 0, 'B': 0, 'C': 0}

    async def _write(self, data: bytes):
        
        if not self.client or not self.client.is_connected:
            raise ConnectionError("设备未连接")
        await self.client.write_gatt_char(WRITE_UUID, data)

    @property
    def is_connected(self) -> bool:
        return self.state.connected

    def get_status(self) -> dict:
        
        return {
            'connected': self.state.connected,
            'device_name': self.name,
            'battery': self.state.battery_level,
            'info': str(self.state.device_info) if self.state.device_info else None,
            'speeds': dict(self.state.speeds),
            'modes': dict(self.state.modes),
        }
