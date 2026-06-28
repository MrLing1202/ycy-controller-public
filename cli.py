"""
YCY Controller — 命令行界面
============================

提供交互式命令行控制。
"""

import asyncio
import sys
import logging
from device import YCYDevice
from patterns import PatternEngine, PatternConfig, PatternType

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")


async def main():
    name = sys.argv[1] if len(sys.argv) > 1 else 'YCY-FJB-03'
    device = YCYDevice(name=name)
    engine = PatternEngine(device)

    try:
        print(f"\n⚡ YCY Controller CLI\n{'='*40}")
        print(f"正在连接设备 [{name}] ...")

        if not await device.connect():
            print("❌ 连接失败，请确认设备已开启")
            return

        print("✅ 已连接!\n")

        while True:
            print("\n─── 命令 ───────────────────────────")
            print("  speed A|B|C <0-40>  设置速率")
            print("  mode  A|B|C <0-7>   设置模式")
            print("  stop                紧急停止")
            print("  info                设备信息")
            print("  auto <模式>         启动自动 (random/wave/pulse/escalate/combo)")
            print("  quit                退出")
            print("─────────────────────────────────────")

            try:
                cmd = input("\n> ").strip()
            except (EOFError, KeyboardInterrupt):
                break

            if not cmd:
                continue

            parts = cmd.split()
            action = parts[0].lower()

            if action == 'quit' or action == 'q':
                break

            elif action == 'stop':
                if engine.is_running:
                    await engine.stop()
                await device.emergency_stop()
                print("🛑 已停止")

            elif action == 'info':
                s = device.get_status()
                print(f"电量: {s['battery']}%")
                print(f"速率: {s['speeds']}")
                print(f"模式: {s['modes']}")
                if s['info']:
                    print(f"设备: {s['info']}")

            elif action == 'speed' and len(parts) == 3:
                ch = parts[1].upper()
                val = int(parts[2])
                await device.set_speed(**{ch.lower(): val})
                print(f"✅ {ch} 速率 → {val}")

            elif action == 'mode' and len(parts) == 3:
                ch = parts[1].upper()
                val = int(parts[2])
                await device.set_mode(ch, val)
                print(f"✅ {ch} 模式 → {val}")

            elif action == 'auto' and len(parts) >= 2:
                pat_name = parts[1].lower()
                try:
                    pat = PatternType(pat_name)
                except ValueError:
                    print(f"❌ 未知模式: {pat_name}")
                    continue

                config = PatternConfig(pattern=pat, duration=0)  # 无限
                await engine.start(config)
                print(f"🎭 自动模式 [{pat_name}] 已启动，输入 stop 停止")

            else:
                print("❓ 未知命令")

    finally:
        if engine.is_running:
            await engine.stop()
        await device.disconnect()
        print("\n👋 已退出")


if __name__ == '__main__':
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
