

from __future__ import annotations
import asyncio
import queue
import json
import logging
import os
import sys
import threading
from typing import Optional

from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO

from core.device import YCYDevice
from patterns import PatternEngine, PatternConfig, PatternType
from core.ai_controller import AIController, list_personalities
from voice_analyzer import VoiceAnalyzer, VoiceConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('logs/server.log', encoding='utf-8'),
    ]
)
logger = logging.getLogger("ycy.server")

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config['SECRET_KEY'] = 'ycy-control-2024'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

device: Optional[YCYDevice] = None
engine: Optional[PatternEngine] = None
ai_ctrl: Optional[AIController] = None
voice_analyzer: Optional[VoiceAnalyzer] = None
loop: Optional[asyncio.AbstractEventLoop] = None

def run_async(coro):
    if loop:
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=30)
    return None

def start_event_loop():
    global loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_forever()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def api_status():
    if device:
        return jsonify(device.get_status())
    return jsonify({'connected': False, 'error': '设备未初始化'})

@app.route('/api/ble-config')
def api_ble_config():
    return jsonify({
        'service_uuid': os.environ.get('BLE_SERVICE_UUID', ''),
        'write_uuid': os.environ.get('BLE_WRITE_UUID', ''),
        'notify_uuid': os.environ.get('BLE_NOTIFY_UUID', ''),
        'device_name': os.environ.get('BLE_DEVICE_NAME', 'BLE-DEVICE'),
    })

@app.route('/api/personalities')
def api_personalities():
    return jsonify(list_personalities())

@app.route("/api/personalities/<pid>", methods=["GET"])
def api_personality_detail(pid):
    from pathlib import Path
    p = Path(__file__).parent / "personalities" / f"{pid}.json"
    if not p.exists():
        return jsonify({"error": "not found"}), 404
    import json
    return jsonify(json.loads(p.read_text()))

@app.route("/api/personalities/<pid>", methods=["PUT"])
def api_personality_update(pid):
    from pathlib import Path
    p = Path(__file__).parent / "personalities" / f"{pid}.json"
    import json
    p.write_text(json.dumps(request.json, ensure_ascii=False, indent=2))
    return jsonify({"ok": True})

@app.route("/api/personalities", methods=["POST"])
def api_personality_create():
    from pathlib import Path
    import json
    data = request.json
    pid = data.get("id", "custom")
    p = Path(__file__).parent / "personalities" / f"{pid}.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return jsonify({"ok": True, "id": pid})

@socketio.on('connect')
def handle_connect():
    logger.info("客户端已连接")
    if device:
        socketio.emit('status', device.get_status())

@socketio.on('scan')
def handle_scan():
    logger.info("扫描设备...")

    async def do_scan():
        devices = await device.scan(timeout=8)
        result = [{'name': n, 'address': a} for n, a, _ in devices]
        socketio.emit('scan_result', {'devices': result})

    threading.Thread(target=lambda: run_async(do_scan()), daemon=True).start()

@socketio.on('connect_device')
def handle_connect_device(data=None):
    name = (data or {}).get('name', os.environ.get('BLE_DEVICE_NAME', 'BLE-DEVICE'))
    logger.info(f"连接设备: {name}")

    async def do_connect():
        device.name = name
        success = await device.connect()
        socketio.emit('connect_result', {
            'success': success,
            'status': device.get_status()
        })

    threading.Thread(target=lambda: run_async(do_connect()), daemon=True).start()

@socketio.on('disconnect_device')
def handle_disconnect():
    async def do_disconnect():
        if engine and engine.is_running:
            await engine.stop()
        await device.disconnect()
        socketio.emit('status', device.get_status())

    threading.Thread(target=lambda: run_async(do_disconnect()), daemon=True).start()

@socketio.on('set_speed')
def handle_set_speed(data):
    a = data.get('a')
    b = data.get('b')
    c = data.get('c')
    logger.info(f"设置速率: A={a} B={b} C={c}")

    async def do():
        await device.set_speed(a=a, b=b, c=c)
        socketio.emit('status', device.get_status())

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('set_mode')
def handle_set_mode(data):
    channel = data.get('channel', 'A')
    mode = data.get('mode', 0)
    logger.info(f"设置模式: {channel}={mode}")

    async def do():
        await device.set_mode(channel, mode)
        socketio.emit('status', device.get_status())

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('stop_all')
def handle_stop_all():
    logger.info("紧急停止!")

    async def do():
        if engine and engine.is_running:
            await engine.stop()
        await device.emergency_stop()
        socketio.emit('status', device.get_status())

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('start_pattern')
def handle_start_pattern(data):
    logger.info(f"启动模式: {data}")

    async def do():
        config = PatternConfig(
            pattern=PatternType(data.get('pattern', 'random')),
            duration=data.get('duration', 60),
            interval=tuple(data.get('interval', [3, 10])),
            a_range=tuple(data.get('a_range', [0, 20])),
            b_range=tuple(data.get('b_range', [0, 15])),
            c_range=tuple(data.get('c_range', [0, 15])),
            script=data.get('script'),
        )
        await engine.start(config)
        socketio.emit('pattern_started', config.to_dict())

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('stop_pattern')
def handle_stop_pattern():
    async def do():
        await engine.stop()
        socketio.emit('pattern_stopped', {'ok': True})
        socketio.emit('status', device.get_status())

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('start_ai')
def handle_start_ai(data):
    personality_id = data.get('personality_id', 'balanced')
    max_duration = data.get('max_duration', 1800)
    logger.info(f"启动AI控制: {personality_id}, 时长 {max_duration}s")

    async def do():
        global ai_ctrl
        ai_ctrl = AIController(device)

        def on_tick(record):
            socketio.emit('ai_tick', {
                'step_count': record['step'],
                'edge_count': ai_ctrl.edge_count,
                'intensity': round(ai_ctrl.intensity, 1),
                'elapsed': round(ai_ctrl.elapsed, 1),
                'mood': record['mood'],
                'behavior': record['behavior'],
                'speeds': {'a': record['a'], 'b': record['b'], 'c': record['c']},
            })

        def on_narration(text):
            socketio.emit('ai_narration', {
                'narration': text,
                'mood': ai_ctrl._history[-1]['mood'] if ai_ctrl._history else '💭',
                'behavior': ai_ctrl._history[-1]['behavior'] if ai_ctrl._history else '',
            })

        ai_ctrl.on_tick(on_tick)
        ai_ctrl.on_narration(on_narration)

        global voice_analyzer
        voice_analyzer = VoiceAnalyzer()
        voice_analyzer.on_climax(ai_ctrl.on_voice_climax)

        try:
            await ai_ctrl.start(personality_id, max_duration)
            socketio.emit('ai_started', {
                'personality': {
                    'id': ai_ctrl._personality.id,
                    'name': ai_ctrl._personality.name,
                    'emoji': ai_ctrl._personality.emoji,
                },
                'max_duration': max_duration,
            })

            while ai_ctrl.is_running:
                await asyncio.sleep(1)

            socketio.emit('ai_stopped', {
                'step_count': ai_ctrl.step_count,
                'edge_count': ai_ctrl.edge_count,
            })
        except Exception as e:
            logger.error(f"AI控制出错: {e}")
            socketio.emit('ai_stopped', {'error': str(e)})

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('stop_ai')
def handle_stop_ai():
    logger.info("停止AI控制")

    async def do():
        global ai_ctrl
        if ai_ctrl and ai_ctrl.is_running:
            await ai_ctrl.stop()
            socketio.emit('ai_stopped', {
                'step_count': ai_ctrl.step_count,
                'edge_count': ai_ctrl.edge_count,
            })
        socketio.emit('status', device.get_status())

    threading.Thread(target=lambda: run_async(do()), daemon=True).start()

@socketio.on('ai_feedback')
def handle_ai_feedback(data):
    if ai_ctrl and ai_ctrl.is_running:
        is_positive = data.get('positive', True)
        ai_ctrl.submit_feedback(is_positive)

@socketio.on('voice_data')
def handle_voice_data(data):
    if voice_analyzer:
        voice_analyzer.process_audio_data(data)

@socketio.on('ai_chat')
def handle_ai_chat(data):
    msg = data.get('message', '')
    if ai_ctrl and ai_ctrl.is_running:
        try:
            prompt = ai_ctrl._personality.build_system_prompt()
            messages = [
                {"role": "system", "content": prompt},
                {"role": "user", "content": f"用户对你说: {msg}\n请以你的人格角色回复1-2句话。"},
            ]
            loop = asyncio.get_event_loop()
            response = loop.run_in_executor(None, ai_ctrl._call_ai, messages)
            import concurrent.futures
            if isinstance(response, concurrent.futures.Future):
                response = response.result(timeout=15)
            socketio.emit('ai_chat_response', {'response': response, 'mood': '💬'})
        except Exception as e:
            logger.error(f"AI聊天出错: {e}")
            socketio.emit('ai_chat_response', {'response': '...', 'mood': '💭'})
    else:
        socketio.emit('ai_chat_response', {'response': '先启动AI再说', 'mood': '💤'})

@socketio.on('voice_message')
def handle_voice_message(data):
    audio = data.get('audio', '')
    logger.info(f"收到语音消息: {len(audio)} bytes")
    socketio.emit('ai_chat_response', {'response': '[收到语音]', 'mood': '🎙️'})


# --- HTTP Polling API (替代Socket.IO) ---
import queue, uuid as _uuid
_event_log = []

def _emit_event(event, data):
    logger.info(f'[EVENT] {event}: {str(data)[:100]}')
    _event_log.append({'event': event, 'data': data, 'ts': __import__('time').time()})
    if len(_event_log) > 500:
        del _event_log[:len(_event_log) - 500]

@app.route('/api/events')
def api_events():
    since = float(request.args.get('since', '0'))
    events = [e for e in _event_log if e['ts'] > since][-50:]
    return jsonify({'events': events, 'since': __import__('time').time()})

@app.route('/api/cmd', methods=['POST'])
def api_cmd():
    d = request.json or {}
    cmd = d.get('cmd','')
    a = d.get('args', {})
    logger.info(f'[API] cmd={cmd} args={a}')
    if cmd == 'set_speed':
        async def _():
            await device.set_speed(a=a.get('a',0), b=a.get('b',0), c=a.get('c',0))
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'set_mode':
        async def _():
            await device.set_mode(a.get('channel','A'), a.get('mode',0))
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'scan':
        async def _():
            devs = await device.scan(timeout=8)
            _emit_event('scan_result', {'devices': [{'name':n,'address':ad} for n,ad,_ in devs]})
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'connect':
        n = a.get('name','')
        async def _():
            if n: device.name = n
            ok = await device.connect()
            _emit_event('connect_result', {'success': ok})
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'disconnect':
        async def _():
            await device.disconnect()
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'stop_all':
        async def _():
            if engine and engine.is_running: await engine.stop()
            await device.emergency_stop()
            if ai_ctrl and ai_ctrl.is_running: await ai_ctrl.stop()
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'start_ai':
        pid = a.get('personality_id','balanced')
        dur = a.get('max_duration',1800)
        async def _():
            global ai_ctrl
            try:
                logger.info(f'[AI] Starting personality={pid}')
                ai_ctrl = AIController(device)
                ai_ctrl.on_tick(lambda r: _emit_event('ai_tick', {
                    'step_count':r['step'],'edge_count':ai_ctrl.edge_count,
                    'intensity':round(ai_ctrl.intensity,1),'elapsed':round(ai_ctrl.elapsed,1),
                    'mood':r['mood'],'behavior':r['behavior'],
                    'speeds':{k:r[k] for k in 'abc'}
                }))
                ai_ctrl.on_narration(lambda t: _emit_event('ai_narration', {
                    'narration':t,
                    'mood':(ai_ctrl._history[-1]['mood'] if ai_ctrl._history else '...'),
                    'behavior':(ai_ctrl._history[-1]['behavior'] if ai_ctrl._history else '')
                }))
                try:
                    voice_analyzer = VoiceAnalyzer()
                    voice_analyzer.on_climax(ai_ctrl.on_voice_climax)
                except Exception as ve:
                    logger.warning(f'[AI] voice_analyzer init failed: {ve}')
                logger.info(f'[AI] Calling start()...')
                await ai_ctrl.start(pid, dur)
                logger.info(f'[AI] Started OK')
                _emit_event('ai_started', {
                    'personality':{'id':ai_ctrl._personality.id,'name':ai_ctrl._personality.name,'emoji':ai_ctrl._personality.emoji},
                    'max_duration':dur
                })
                while ai_ctrl.is_running:
                    await asyncio.sleep(1)
                _emit_event('ai_stopped', {'step_count':ai_ctrl.step_count,'edge_count':ai_ctrl.edge_count})
            except Exception as e:
                logger.error(f'[AI] CRASH: {type(e).__name__}: {e}')
                _emit_event('ai_stopped', {'error':str(e)})
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'stop_ai':
        async def _():
            if ai_ctrl and ai_ctrl.is_running:
                await ai_ctrl.stop()
                _emit_event('ai_stopped', {'step_count':ai_ctrl.step_count,'edge_count':ai_ctrl.edge_count})
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'ai_chat':
        msg = a.get('message','')
        if ai_ctrl and ai_ctrl.is_running:
            try:
                speeds = ai_ctrl.device.state.speeds
                prompt = ai_ctrl._personality.build_system_prompt()
                prompt += f"""
用户对你说: {msg}

你必须回复1-2条消息，每条消息都包含速度调整。
回复格式(严格JSON数组):
[
  {{"text":"你的话","a":0-40,"b":0-20,"c":0-20,"mood":"emoji"}},
  {{"text":"第二句(可选)","a":0-40,"b":0-20,"c":0-20,"mood":"emoji"}}
]
当前速度: A={speeds['A']} B={speeds['B']} C={speeds['C']}
每条消息都会实时应用到设备。根据你的角色和对话内容决定强度变化。"""
                msgs = [{"role":"system","content":prompt},{"role":"user","content":msg}]
                loop = asyncio.get_event_loop()
                resp = loop.run_in_executor(None, ai_ctrl._call_ai, msgs)
                if hasattr(resp, 'result'): resp = resp.result(timeout=15)
                import json as _json
                try:
                    arr = _json.loads(resp)
                    if isinstance(arr, dict): arr = [arr]
                    for item in arr[:2]:
                        text = item.get('text','')
                        mood = item.get('mood','💬')
                        sa, sb, sc = item.get('a'), item.get('b'), item.get('c')
                        if sa is not None and sb is not None and sc is not None:
                            async def _a(saa=sa, sbb=sb, scc=sc):
                                try: await ai_ctrl.device.set_speed(a=int(saa), b=int(sbb), c=int(scc))
                                except: pass
                            threading.Thread(target=lambda: run_async(_a()), daemon=True).start()
                            _emit_event('ai_chat_response', {'response':text,'mood':mood,'speeds':{'a':int(sa),'b':int(sb),'c':int(sc)}})
                        else:
                            _emit_event('ai_chat_response', {'response':text,'mood':mood})
                        import time as _t; _t.sleep(0.5)
                except:
                    _emit_event('ai_chat_response', {'response':resp,'mood':'💬'})
            except Exception as e:
                logger.error(f'[AI_CHAT] {e}')
                _emit_event('ai_chat_response', {'response':'...','mood':'💭'})
        else:
            _emit_event('ai_chat_response', {'response':'先启动AI再说','mood':'💤'})
    elif cmd == 'ai_feedback':
        if ai_ctrl and ai_ctrl.is_running:
            ai_ctrl.submit_feedback(a.get('positive', True))
    elif cmd == 'voice_data':
        if voice_analyzer:
            voice_analyzer.process_audio_data(a)
    elif cmd == 'voice_message':
        logger.info(f'[VOICE] 收到语音消息: {len(str(a.get("audio","")))} bytes')
    elif cmd == 'start_pattern':
        async def _():
            config = PatternConfig(pattern=PatternType(a.get('pattern','random')),duration=a.get('duration',60),interval=tuple(a.get('interval',[3,10])),a_range=tuple(a.get('a_range',[0,40])),b_range=tuple(a.get('b_range',[0,20])),c_range=tuple(a.get('c_range',[0,20])),script=a.get('script'))
            # Patch engine to emit events
            orig_run = engine._run
            async def patched_run(cfg):
                import random as _rand
                start_time = __import__('time').time()
                gen = engine._get_generator(cfg)
                engine._running = True
                engine._step_count = 0
                try:
                    while engine._running:
                        elapsed = __import__('time').time() - start_time
                        if cfg.duration > 0 and elapsed >= cfg.duration:
                            break
                        ra, rb, rc = next(gen)
                        # Power coupling
                        if rb > 0:
                            ratio = 1.0 - (rb / 20.0) * 0.8
                            ra = min(ra, max(0, int(40 * ratio)))
                        try: await device.set_speed(a=ra, b=rb, c=rc)
                        except: pass
                        engine._step_count += 1
                        _emit_event('ai_tick', {
                            'step_count': engine._step_count, 'edge_count': 0,
                            'intensity': round((ra/40+rb/20+rc/20)/3*100, 1),
                            'elapsed': round(elapsed, 1),
                            'mood': _rand.choice(['🎲','🌊','💓','📈','🔀','📜']),
                            'behavior': cfg.pattern.value,
                            'speeds': {'a': ra, 'b': rb, 'c': rc}
                        })
                        delay = _rand.uniform(*cfg.interval)
                        await asyncio.sleep(delay)
                        if rb > 0 and cfg.b_exhale_ratio > 0:
                            exhale = max(0.5, min(3.0, delay * cfg.b_exhale_ratio))
                            try: await device.set_speed(b=0)
                            except: pass
                            await asyncio.sleep(exhale)
                except: pass
                finally:
                    engine._running = False
                    try: await device.emergency_stop()
                    except: pass
            engine._run = patched_run
            await engine.start(config)
            _emit_event('pattern_started', {'pattern': a.get('pattern','random')})
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'stop_pattern':
        async def _():
            await engine.stop()
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    elif cmd == 'start_random':
        import random as _rand
        interval = a.get('interval', [2, 6])
        rest_chance = a.get('rest_chance', 0.25)
        async def _():
            logger.info(f'[RANDOM] Starting random mode interval={interval} rest_chance={rest_chance}')
            _emit_event('ai_started', {'personality':{'id':'random','name':'随机','emoji':'🎲'}, 'max_duration': 0})
            step = 0
            while True:
                # 有概率休息(全零)
                if _rand.random() < rest_chance:
                    ra, rb, rc = 0, 0, 0
                else:
                    ra = _rand.randint(1, 40)
                    rb = _rand.randint(0, 20)
                    rc = _rand.randint(0, 20)
                try: await device.set_speed(a=ra, b=rb, c=rc)
                except: pass
                step += 1
                moods = ['🎲','⚡','🔥','💫','🌊','💥','🎵','✨']
                _emit_event('ai_tick', {
                    'step_count': step, 'edge_count': 0,
                    'intensity': round((ra/40 + rb/20 + rc/20) / 3 * 100, 1),
                    'elapsed': step * 3,
                    'mood': _rand.choice(moods),
                    'behavior': 'random',
                    'speeds': {'a': ra, 'b': rb, 'c': rc}
                })
                _emit_event('ai_narration', {
                    'narration': f'A={ra} B={rb} C={rc}',
                    'mood': _rand.choice(moods),
                    'behavior': 'random'
                })
                delay = _rand.uniform(interval[0], interval[1])
                await asyncio.sleep(delay)
        threading.Thread(target=lambda: run_async(_()), daemon=True).start()
    return jsonify({'ok':True})

@app.route('/api/settings', methods=['GET'])
def api_settings_get():
    from pathlib import Path
    env_path = Path(__file__).parent / '.env'
    settings = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                settings[k] = v
    # Mask sensitive values
    result = {}
    for k, v in settings.items():
        if 'KEY' in k or 'key' in k:
            result[k] = '***' if v else ''
        else:
            result[k] = v
    return jsonify(result)

@app.route('/api/settings', methods=['POST'])
def api_settings_save():
    from pathlib import Path
    data = request.json or {}
    env_path = Path(__file__).parent / '.env'
    existing = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                existing[k] = v
    # Update with new values (skip masked keys)
    for k, v in data.items():
        if v == '***':  # Don't overwrite masked values
            continue
        existing[k] = v
    # Write back
    lines = [f'{k}={v}' for k, v in existing.items()]
    env_path.write_text(chr(10).join(lines) + chr(10))
    return jsonify({'ok': True, 'message': '设置已保存，重启服务生效'})


def main():
    # 解码.env中的base64加密值
    import base64 as _b64
    from pathlib import Path as _Path
    _env = _Path(__file__).parent / '.env'
    if _env.exists():
        _lines = []
        for _line in _env.read_text().splitlines():
            _line = _line.strip()
            if _line and '=' in _line and not _line.startswith('#'):
                _k, _v = _line.split('=', 1)
                if _v.startswith('B64:'):
                    try:
                        _v = _b64.b64decode(_v[4:]).decode()
                    except: pass
                os.environ[_k] = _v
            elif _line:
                _lines.append(_line)

    global device, engine

    device_name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('BLE_DEVICE_NAME', 'BLE-DEVICE')

    def on_battery(level):
        socketio.emit('battery', {'level': level})

    def on_disconnect():
        socketio.emit('disconnected', {})

    device = YCYDevice(
        name=device_name,
        on_battery=on_battery,
        on_disconnect=on_disconnect,
    )
    engine = PatternEngine(device)

    t = threading.Thread(target=start_event_loop, daemon=True)
    t.start()

    port = int(os.environ.get('PORT', 8080))
    logger.info(f"═══ YCY Controller 已启动 ═══")
    logger.info(f"浏览器打开: http://localhost:{port}")
    logger.info(f"目标设备: {device_name}")

    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)

if __name__ == '__main__':
    main()
