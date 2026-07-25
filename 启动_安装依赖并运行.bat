@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 检查 Python...
py --version || goto :no_python
echo [2/3] 安装/更新依赖...
py -m pip install --upgrade pip
py -m pip install -r requirements.txt
if not exist .env copy .env.example .env >nul
echo [3/3] 启动程序...
py run.py
pause
exit /b
:no_python
echo 未找到 Python。请先安装 Python 3.10 或更高版本，并勾选 Add Python to PATH。
pause
