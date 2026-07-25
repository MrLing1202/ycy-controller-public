# YCY Audio Reactive Controller

这是一个重新设计的独立控制程序，保留 ycy-controller-public 的 BLE 协议和 A/B/C 参数控制方式，并新增“视频/屏幕声音实时调整强度”功能。

## 功能

- Web Bluetooth 直连 BLE 设备，不依赖服务器蓝牙
- 手动控制 A/B/C 三通道速度
- A/B/C 内建模式设置
- 本地视频/音频文件响度分析
- 屏幕/标签页共享音频分析
- 响度实时映射到强度，再映射到 A/B/C 输出
- 可调参数：静音阈值、增益、冲击响应、回落速度、发送频率、静音归零、通道上限、通道权重
- 紧急停止、断开前停止、页面关闭尽力停止
- 默认低上限，避免声音突变直接拉满

## 运行

Windows 直接双击：

```bat
启动_安装依赖并运行.bat
```

或手动运行：

```bat
py -m pip install -r requirements.txt
py run.py
```

浏览器打开：

```text
http://localhost:8080
```

建议使用 Chrome 或 Edge。Web Bluetooth 需要 `localhost` 或 HTTPS 环境。

## 使用步骤

1. 打开页面后，先点击“连接 BLE 设备”。
2. 先用手动控制测试 A/B/C 是否正常。
3. 上传本地视频/音频，或点击“捕获屏幕声音”。
4. 保持较低上限，点击“启动音频跟随”。
5. 根据效果逐步调整增益、上限和权重。
6. 异常时点击“紧急停止”。

## 声音捕获说明

- 本地文件：选择视频/音频后，页面能直接分析其声音。
- 网页视频：点击“捕获屏幕声音”，选择对应标签页，并勾选共享音频。
- 有些浏览器/系统不会提供系统音频轨道，这是浏览器权限限制，不是程序错误。

## BLE 协议

默认沿用原项目协议：

```text
Service: 0000ff40-0000-1000-8000-00805f9b34fb
Write:   0000ff41-0000-1000-8000-00805f9b34fb
Notify:  0000ff42-0000-1000-8000-00805f9b34fb
包格式: [0x35, CMD, ...DATA, CHECKSUM]
校验:   sum(非校验字节) % 256
```

速度命令：

```text
[35 12 A B C CS]
A: 0-40
B: 0-20
C: 0-20
```

模式命令：

```text
[35 11 MOTOR_CODE MODE CS]
A MOTOR_CODE = 0x01
B MOTOR_CODE = 0x12
C MOTOR_CODE = 0x14
MODE = 0-7
```

## 安全默认值

- B 通道默认关闭，需要手动勾选。
- A/C 上限默认低于最大值。
- 静音超过设定秒数会自动回落到 0。
- 发送频率默认 6Hz，避免蓝牙写入过密。
- 页面断开或关闭时会尽力发送停止包。

## Windows 快速启动

如果中文文件名显示异常，直接双击：

```bat
start.bat
```

或：

```bat
run_windows.bat
```

两个脚本都会自动安装依赖并运行 `py run.py`。

## 本版调整

- 增益滑条最大值从 8 提高到 30，默认仍为 3.0。建议先从 3–8 小范围测试，再逐步提高。


## 低音量增强版说明

如果视频声音比较小，旧版会先用“静音阈值”把低于门限的响度全部切成 0，再乘以增益，所以只调增益没有效果。本版将默认静音阈值降低到 0.006，并加入“弱声增强”和“最低强度”两个参数。

推荐初始设置：静音阈值 0.003-0.008，增益 6-12，弱声增强 0.35-0.55，最低强度 0.03-0.10。


## Push test branch

Run `PUSH_TO_GITHUB_TEST_BRANCH.bat` after extracting the ZIP. It creates/pushes branch `test/audio-reactive-controller` to `MrLing1202/ycy-controller-public`.
