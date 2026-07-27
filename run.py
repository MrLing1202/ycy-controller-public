#!/usr/bin/env python3
"""YCY Controller Launcher (Protected)"""
import importlib.util, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
# 从编译后的.pyc启动
spec = importlib.util.spec_from_file_location("server", "server.pyc")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
