#!/usr/bin/env python3
"""
YCY Controller — 入口
======================

用法:
  python run.py              启动 Web 控制面板 (http://localhost:8080)
  python run.py --cli        启动命令行界面
  python run.py --name XXX   指定设备名称
"""

import sys


def main():
    args = sys.argv[1:]
    name = 'YCY-FJB-03'

    # 解析 --name
    for i, arg in enumerate(args):
        if arg == '--name' and i + 1 < len(args):
            name = args[i + 1]
            args = args[:i] + args[i+2:]
            break

    if '--cli' in args:
        # 命令行模式
        sys.argv = ['cli.py', name]
        from cli import main as cli_main
        import asyncio
        if sys.platform == "win32":
            import asyncio
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run(cli_main())
    else:
        # Web 模式 (默认)
        sys.argv = ['server.py', name]
        from server import main as server_main
        server_main()


if __name__ == '__main__':
    main()
