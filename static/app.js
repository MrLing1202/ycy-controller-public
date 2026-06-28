
function buttonFeedback(el) {
  if (!el) return;
  el.style.transform = 'scale(0.93)';
  el.style.filter = 'brightness(0.85)';
  setTimeout(function() { el.style.transform = ''; el.style.filter = ''; }, 150);
}
// === HTTP Polling通信层（零依赖）===
var _sid = null;
var _pollTimer = null;
var _cbs = {};

function socket_emit(event, data) {
  fetch('/api/cmd', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({cmd: event, args: data || {}})
  }).catch(function(){});
}

function socket_on(event, cb) {
  if (!_cbs[event]) _cbs[event] = [];
  _cbs[event].push(cb);
}

function _fire(event, data) {
  if (_cbs[event]) {
    _cbs[event].forEach(function(cb) { try { cb(data); } catch(e) {} });
  }
}

var _lastSince = 0;
function _poll() {
  fetch('/api/events?since=' + _lastSince)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _lastSince = d.since || _lastSince;
      if (d.events) {
        d.events.forEach(function(ev) { _fire(ev.event, ev.data); });
      }
    })
    .catch(function(){})
    .finally(function() {
      _pollTimer = setTimeout(_poll, 500);
    });
}
_poll();

// Communication layer complete - all calls use socket_emit/socket_on directly


var selectedPattern = 'random';
var isConnected = false;
var aiRunning = false;
var intensityHistory = [];
var MAX_HISTORY = 200;
var darkMode = true;
var bleDevice = null, bleChar = null, bleConfig = null;
var lastFeedback = null;
var recording = false, recordedSteps = [], recStartTime = 0;
var micActive = false, micStream = null, micAnalyser = null, micInterval = null;
var voiceRecorder = null, voiceChunks = [];
var chartCtx = null;

socket_on('connect', function() { addLog('info', '已连接'); });

socket_on('status', function(s) {
  isConnected = s.connected;
  document.getElementById('dot').className = 'status-dot ' + (s.connected ? 'on' : 'off');
  document.getElementById('statusText').textContent = s.connected ? '已连接: ' + s.device_name : '未连接';
  if (s.battery >= 0) {
    document.getElementById('batText').textContent = s.battery + '%';
    document.getElementById('batIcon').textContent = s.battery > 30 ? '🔋' : '🪫';
    if (s.battery < 20) showToast('⚠️ 电量低: ' + s.battery + '%', 'warn');
  }
});
socket_on('battery', function(d) {
  document.getElementById('batText').textContent = d.level + '%';
  document.getElementById('batIcon').textContent = d.level > 30 ? '🔋' : '🪫';
  if (d.level < 20) showToast('⚠️ 电量低: ' + d.level + '%', 'warn');
});
socket_on('scan_result', function(d) {
  var el = document.getElementById('scanList');
  if (!d.devices.length) { el.innerHTML = '<div style="color:var(--red)">未发现设备</div>'; return; }
  el.innerHTML = d.devices.map(function(dev) {
    return '<div style="padding:6px;cursor:pointer;border-bottom:1px solid var(--border)" onclick="selectDevice(\'' + dev.name + '\')">' + dev.name + ' <span style="color:var(--dim)">' + dev.address + '</span></div>';
  }).join('');
  showToast('发现 ' + d.devices.length + ' 个设备', 'ok');
});
socket_on('connect_result', function(d) {
  if (d.success) showToast('✅ 设备连接成功', 'ok');
  else showToast('❌ 连接失败', 'err');
});
socket_on('disconnected', function() {
  showToast('设备已断开', 'warn');
  addLog('warn', '断开，5秒后重连...');
  setTimeout(function() { if (!isConnected) { doConnect(); } }, 5000);
});
socket_on('pattern_started', function(d) { showToast('模式已启动: ' + d.pattern, 'ok'); });
socket_on('pattern_stopped', function() { showToast('模式已停止', 'warn'); });
socket_on('ai_started', function(d) {
  aiRunning = true;
  updateAiUI();
  showToast('🤖 AI已启动: ' + (d.personality ? d.personality.name : ''), 'ok');
  document.getElementById('aiCurrent').style.display = 'flex';
  document.getElementById('aiBehavior').textContent = (d.personality ? d.personality.emoji + ' ' + d.personality.name : '') + ' · 最大 ' + d.max_duration + 's';
});
socket_on('ai_stopped', function(d) {
  aiRunning = false;
  updateAiUI();
  showToast('⏹ AI已停止', 'warn');
  addLog('ai', '停止 (步数:' + (d.step_count||0) + ' Edge:' + (d.edge_count||0) + ')');
});
socket_on('ai_tick', function(d) {
  document.getElementById('aiSteps').textContent = d.step_count || 0;
  document.getElementById('aiEdges').textContent = d.edge_count || 0;
  if (d.elapsed !== undefined) {
    var mins = Math.floor(d.elapsed / 60);
    var secs = Math.floor(d.elapsed % 60);
    document.getElementById('aiElapsed').textContent = mins > 0 ? mins + 'm' + secs + 's' : secs + 's';
  }
  var intensity = d.intensity || 0;
  document.getElementById('aiIntensityBar').style.width = intensity + '%';
  document.getElementById('aiIntensityText').textContent = Math.round(intensity) + '%';
  intensityHistory.push(intensity);
  drawChart();
  if (d.mood) document.getElementById('aiMood').textContent = d.mood;
  if (d.behavior) document.getElementById('aiBehavior').textContent = d.behavior;
  if (d.speeds) {
    document.getElementById('sliderA').value = d.speeds.a || 0;
    document.getElementById('valA').textContent = d.speeds.a || 0;
    document.getElementById('sliderB').value = d.speeds.b || 0;
    document.getElementById('valB').textContent = d.speeds.b || 0;
    document.getElementById('sliderC').value = d.speeds.c || 0;
    document.getElementById('valC').textContent = d.speeds.c || 0;
    updateSpeedBars(d.speeds.a, d.speeds.b, d.speeds.c);
    recordStep(d.speeds.a, d.speeds.b, d.speeds.c);
    if (bleChar) { bleWrite(d.speeds.a, d.speeds.b, d.speeds.c); }
  }
  if (bleChar && d.speeds) bleWrite(d.speeds.a, d.speeds.b, d.speeds.c);
});
socket_on('ai_narration', function(d) {
  var box = document.getElementById('aiNarrationBox');
  if (box.querySelector('div[style]')) box.innerHTML = '';
  var entry = document.createElement('div');
  entry.className = 'entry';
  var span1 = document.createElement('span');
  span1.textContent = (d.mood || '💭') + ' ';
  var span2 = document.createElement('span');
  span2.textContent = d.narration || '';
  entry.appendChild(span1);
  entry.appendChild(span2);
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
  addLog('ai', (d.mood || '💭') + ' ' + (d.narration || ''));
});
socket_on('ai_chat_response', function(d) {
  addChatBubble((d.mood || '') + ' ' + (d.response || ''), false);
  if (d.speeds) {
    document.getElementById('sliderA').value = d.speeds.a || 0;
    document.getElementById('valA').textContent = d.speeds.a || 0;
    document.getElementById('sliderB').value = d.speeds.b || 0;
    document.getElementById('valB').textContent = d.speeds.b || 0;
    document.getElementById('sliderC').value = d.speeds.c || 0;
    document.getElementById('valC').textContent = d.speeds.c || 0;
    updateSpeedBars(d.speeds.a, d.speeds.b, d.speeds.c);
    if (bleChar) bleWrite(d.speeds.a, d.speeds.b, d.speeds.c);
  }
});
function loadPersonalities() {
  fetch('/api/personalities').then(function(r) { return r.json(); }).then(function(data) {
    var sel = document.getElementById('aiPersonality');
    sel.innerHTML = data.map(function(p) { return '<option value="' + p.id + '">' + p.emoji + ' ' + p.name + '</option>'; }).join('');
  }).catch(function() {
    document.getElementById('aiPersonality').innerHTML = '<option value="">加载失败</option>';
  });
}
function toggleAI() {
  try {
    buttonFeedback(document.getElementById('btnAiToggle'));
    if (aiRunning) {
      socket_emit('stop_ai', {});
      socket_emit('stop_all', {});
      if (typeof bleChar !== 'undefined' && bleChar) bleWrite(0,0,0);
      aiRunning = false; randomRunning = false;
      updateAiUI();
      var btn = document.getElementById('randomBtn');
      if (btn) { btn.textContent = '🎲 随机'; btn.style.background = 'var(--orange)'; btn.style.boxShadow = 'none'; }
      showToast('AI+设备已停止', 'warn');
      return;
    }
    var personality = document.getElementById('aiPersonality').value;
    var duration = parseInt(document.getElementById('aiDuration').value) || 1800;
    if (!personality) { showToast('请先选择人格', 'err'); return; }
    showToast('正在启动AI: ' + personality + '...', 'info');
    fetch('/api/cmd', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cmd: 'start_ai', args: {personality_id: personality, max_duration: duration}})
    }).then(function(r) { return r.json(); }).then(function(d) {
      showToast('AI启动: ' + JSON.stringify(d), 'ok');
    }).catch(function(e) {
      showToast('AI启动失败: ' + e.message, 'err');
    });
  } catch(e) {
    showToast('JS错误: ' + e.message, 'err');
  }
}
function updateAiUI() {
  var btn = document.getElementById('btnAiToggle');
  if (aiRunning) { btn.className = 'btn btn-ai running'; btn.textContent = '⏹ 停止 AI'; }
  else { btn.className = 'btn btn-ai'; btn.textContent = '🤖 启动 AI'; document.getElementById('aiCurrent').style.display = 'none'; }
}
function doScan() { buttonFeedback(this); document.getElementById('scanList').innerHTML = '<span style="animation:pulse 1s infinite">🔍 扫描中...</span>'; socket_emit('scan'); }
function doConnect() { buttonFeedback(this); socket_emit('connect', {name: ''}); showToast('正在连接...', 'info'); }
function doDisconnect() { buttonFeedback(this); socket_emit('disconnect'); }
function selectDevice(name) { socket_emit('connect', {name: name}); showToast('连接: ' + name, 'info'); }
function updateVal(ch, v) {
  var maxSpeed = ch === 'A' ? 40 : 20;
  var mapped = sliderToSpeed(+v, maxSpeed);
  document.getElementById('val'+ch).textContent = mapped;
}
var _speedDb = null;
function sendSpeedDebounced() {
  clearTimeout(_speedDb);
  _speedDb = setTimeout(function() {
    var a = sliderToSpeed(+document.getElementById('sliderA').value, 40);
    var b = sliderToSpeed(+document.getElementById('sliderB').value, 20);
    var c = sliderToSpeed(+document.getElementById('sliderC').value, 20);
    if (bleChar) { bleWrite(a, b, c); }
    else {
      fetch('/api/cmd', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({cmd: 'set_speed', args: {a:a, b:b, c:c}})
      });
    }
  }, 150);
}
function sliderToSpeed(v, maxSpeed) {
  // 非线性映射：滑条值 0-100 → 设备速度 0-maxSpeed
  // 低端更细腻：滑条20% → 设备约4%速度
  var t = v / 100;
  var curve = t * t; // 二次曲线，低端压缩
  return Math.round(curve * maxSpeed);
}
function applySpeed() {
  try {
    buttonFeedback(this);
    var a = sliderToSpeed(+document.getElementById('sliderA').value, 40);
    var b = sliderToSpeed(+document.getElementById('sliderB').value, 20);
    var c = sliderToSpeed(+document.getElementById('sliderC').value, 20);
    if (bleChar) { bleWrite(a,b,c); showToast('[BLE] A='+a+' B='+b+' C='+c, 'ok'); }
    else {
      fetch('/api/cmd', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({cmd: 'set_speed', args: {a:a,b:b,c:c}})
      }).then(function(r) { return r.json(); }).then(function(d) {
        showToast('A='+a+' B='+b+' C='+c, 'ok');
      }).catch(function(e) { showToast('发送失败: '+e.message, 'err'); });
    }
  } catch(e) { showToast('JS错误: '+e.message, 'err'); }
}
function setMode(ch) { buttonFeedback(this); var mode = parseInt(document.getElementById('mode'+ch).value); socket_emit('set_mode', {channel:ch, mode:mode}); showToast(ch+'='+mode, 'info'); }
function selectPattern(p) { selectedPattern = p; document.querySelectorAll('.pat-btn').forEach(function(el) { el.classList.remove('active'); }); document.getElementById('pat-'+p).classList.add('active'); document.getElementById('scriptArea').style.display = p === 'script' ? 'block' : 'none'; }
function startPattern() { buttonFeedback(this); var data = {pattern:selectedPattern, duration:parseInt(document.getElementById('patDuration').value), interval:[parseInt(document.getElementById('patIntervalMin').value), parseInt(document.getElementById('patIntervalMax').value)], a_range:[0,40], b_range:[0,20], c_range:[0,20]}; if(selectedPattern==='script'){try{data.script=JSON.parse(document.getElementById('scriptInput').value);}catch(e){showToast('脚本JSON错误','err');return;}} socket_emit('start_pattern', data); }
function stopPattern() { socket_emit('stop_pattern'); }
function startRandom() {
  showToast('🎲 随机模式启动', 'ok');
  fetch('/api/cmd', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({cmd: 'start_random', args: {interval: [2, 6]}})
  }).then(function(r) { return r.json(); }).then(function(d) {
    showToast('🎲 随机模式: ' + JSON.stringify(d), 'ok');
  }).catch(function(e) { showToast('失败: ' + e.message, 'err'); });
}

function addLog(type, msg) { var box = document.getElementById('logBox'); var t = new Date().toLocaleTimeString(); box.innerHTML += '<div class="' + type + '">[' + t + '] ' + msg + '</div>'; box.scrollTop = box.scrollHeight; }
function clearLog() { document.getElementById('logBox').innerHTML = ''; }

function sendChat() {
  try {
    var input = document.getElementById('chatInput');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    addChatBubble(msg, true);
    showToast('发送中...', 'info');
    fetch('/api/cmd', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cmd: 'ai_chat', args: {message: msg}})
    }).then(function(r) { return r.json(); }).then(function(d) {
      showToast('已发送', 'ok');
    }).catch(function(e) {
      showToast('发送失败: ' + e.message, 'err');
    });
  } catch(e) {
    showToast('JS错误: ' + e.message, 'err');
  }
}
function addChatBubble(text, isUser) {
  var box = document.getElementById('aiNarrationBox');
  if (!box) return;
  var div = document.createElement('div');
  div.style.cssText = isUser ? 'text-align:right;margin:4px 0' : 'text-align:left;margin:4px 0';
  var span = document.createElement('span');
  span.style.cssText = 'display:inline-block;padding:6px 10px;border-radius:12px;max-width:80%;font-size:0.82em;word-break:break-all;' + (isUser ? 'background:var(--accent);color:#fff' : 'background:var(--border);color:var(--text)');
  span.textContent = text;
  div.appendChild(span);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
async function startVoice() {
  try {
    var stream = await navigator.mediaDevices.getUserAudio({audio: true});
    voiceRecorder = new MediaRecorder(stream);
    voiceChunks = [];
    voiceRecorder.ondataavailable = function(e) { voiceChunks.push(e.data); };
    voiceRecorder.onstop = function() {
      var blob = new Blob(voiceChunks, {type: 'audio/webm'});
      var reader = new FileReader();
      reader.onload = function() { socket_emit('voice_message', {audio: reader.result}); addChatBubble('语音已发送', true); };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(function(t) { t.stop(); });
    };
    voiceRecorder.start();
    document.getElementById('voiceBtn').textContent = '●';
    document.getElementById('voiceBtn').style.color = 'var(--red)';
    showToast('🎙️ 录音中...', 'info');
  } catch(e) { showToast('麦克风权限拒绝', 'err'); }
}
function stopVoice() {
  if (voiceRecorder && voiceRecorder.state === 'recording') {
    voiceRecorder.stop();
    document.getElementById('voiceBtn').textContent = '🎙️';
    document.getElementById('voiceBtn').style.color = '';
  }
}
async function toggleMic() {
  buttonFeedback(document.getElementById('micBtn'));
  if (micActive) {
    micActive = false;
    if (micStream) micStream.getTracks().forEach(function(t) { t.stop(); });
    if (micInterval) clearInterval(micInterval);
    micStream = null; micAnalyser = null;
    document.getElementById('micBtn').classList.remove('active');
    document.getElementById('micBtn').textContent = '🎤';
    document.getElementById('micMeter').style.width = '0%';
    showToast('🎤 监听已关闭', 'warn');
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio: true});
    var ctx = new AudioContext();
    var src = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 2048;
    src.connect(micAnalyser);
    micActive = true;
    document.getElementById('micBtn').classList.add('active');
    document.getElementById('micBtn').textContent = '🎤●';
    showToast('🎤 声纹监听已开启', 'ok');
    var buf = new Uint8Array(micAnalyser.frequencyBinCount);
    var fbuf = new Float32Array(micAnalyser.frequencyBinCount);
    micInterval = setInterval(function() {
      if (!micActive) return;
      micAnalyser.getByteTimeDomainData(buf);
      var s = 0;
      for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; s += v * v; }
      var vol = Math.min(100, Math.sqrt(s / buf.length) * 300);
      micAnalyser.getFloatFrequencyData(fbuf);
      var mx = -Infinity, mi = 0;
      for (var i = 2; i < fbuf.length / 2; i++) { if (fbuf[i] > mx) { mx = fbuf[i]; mi = i; } }
      var pitch = mi * ctx.sampleRate / micAnalyser.fftSize;
      socket_emit('voice_data', {volume: vol, pitch: pitch, timestamp: Date.now() / 1000});
      document.getElementById('micMeter').style.width = vol + '%';
      document.getElementById('micMeter').style.background = vol > 70 ? 'var(--red)' : vol > 40 ? 'var(--orange)' : 'var(--green)';
    }, 100);
  } catch(e) { showToast('麦克风权限拒绝', 'err'); }
}
function toggleRecord() {
  buttonFeedback(document.getElementById('recBtn'));
  if (recording) { recording = false; document.getElementById('recBtn').textContent = '⏺'; document.getElementById('recBtn').classList.remove('active'); showToast('录制完成 ' + recordedSteps.length + '步', 'ok'); return; }
  recording = true; recordedSteps = []; recStartTime = Date.now();
  document.getElementById('recBtn').textContent = '⏹'; document.getElementById('recBtn').classList.add('active');
  showToast('⏺ 录制中...', 'info');
}
function recordStep(a, b, c) { if (!recording) return; recordedSteps.push({a:a,b:b,c:c,t:Date.now()-recStartTime}); }
function playRecording() {
  buttonFeedback(this);
  if (!recordedSteps.length) { showToast('无录制数据', 'err'); return; }
  showToast('▶ 回放 ' + recordedSteps.length + '步', 'ok');
  var i = 0;
  function step() {
    if (i >= recordedSteps.length) { showToast('回放完成', 'ok'); return; }
    var s = recordedSteps[i];
    if (bleChar) bleWrite(s.a,s.b,s.c); else socket_emit('set_speed', {a:s.a,b:s.b,c:s.c});
    i++;
    var delay = i < recordedSteps.length ? recordedSteps[i].t - s.t : 1000;
    setTimeout(step, Math.max(50, delay));
  }
  step();
}
function exportRecording() {
  buttonFeedback(this);
  if (!recordedSteps.length) { showToast('无录制数据', 'err'); return; }
  document.getElementById('scriptInput').value = JSON.stringify(recordedSteps.map(function(s) { return {a:s.a,b:s.b,c:s.c}; }));
  showToast('💾 已导出到脚本', 'ok');
}
function updateSpeedBars(a, b, c) {
  var bars = document.querySelectorAll('.speed-bar');
  if (bars.length >= 3) { bars[0].style.height = (a/40*100)+'%'; bars[1].style.height = (b/20*100)+'%'; bars[2].style.height = (c/20*100)+'%'; }
}
function sendFeedback(p) {
  buttonFeedback(document.getElementById(p ? 'fbGood' : 'fbBad'));
  lastFeedback = p;
  socket_emit('ai_feedback', {positive: p});
  document.querySelectorAll('.fb-btn').forEach(function(b) { b.classList.remove('selected'); });
  document.getElementById(p ? 'fbGood' : 'fbBad').classList.add('selected');
  document.getElementById('fbDisplay').textContent = p ? '👍' : '👎';
  showToast(p ? '👍 享受' : '👎 抗拒', p ? 'ok' : 'warn');
}
async function loadBleConfig() { try { var r = await fetch('/api/ble-config'); bleConfig = await r.json(); } catch(e) {} }
loadBleConfig();
async function bleConnect() {
  if (!navigator.bluetooth) { showToast('浏览器不支持Web Bluetooth', 'err'); return; }
  if (!bleConfig || !bleConfig.service_uuid) { showToast('蓝牙配置未加载', 'err'); return; }
  try {
    showToast('扫描蓝牙...', 'info');
    bleDevice = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: [bleConfig.service_uuid]});
    showToast('找到: ' + bleDevice.name, 'ok');
    var server = await bleDevice.gatt.connect();
    var service = await server.getPrimaryService(bleConfig.service_uuid);
    bleChar = await service.getCharacteristic(bleConfig.write_uuid);
    try { var nc = await service.getCharacteristic(bleConfig.notify_uuid); await nc.startNotifications(); nc.addEventListener('characteristicvaluechanged', onBleNotify); } catch(e) {}
    isConnected = true;
    document.getElementById('dot').className = 'dot on';
    document.getElementById('statusText').textContent = 'BLE: ' + bleDevice.name;
    document.getElementById('bleBtn').textContent = '断开';
    document.getElementById('bleBtn').onclick = bleDisconnect;
    showToast('蓝牙连接成功!', 'ok');
    bleDevice.addEventListener('gattserverdisconnected', function() {
      isConnected = false; bleChar = null;
      document.getElementById('dot').className = 'dot off';
      document.getElementById('statusText').textContent = '蓝牙断开';
      document.getElementById('bleBtn').textContent = '蓝牙';
      document.getElementById('bleBtn').onclick = bleConnect;
      showToast('蓝牙断开', 'warn');
    });
  } catch(e) { showToast('蓝牙失败: ' + e.message, 'err'); }
}
function bleDisconnect() { if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect(); }
async function bleWrite(a, b, c) {
  if (!bleChar) return false;
  try { var pkt = buildPacket(0x12, [a, b, c]); await bleChar.writeValue(pkt); return true; }
  catch(e) { showToast('蓝牙写入失败', 'err'); return false; }
}
function buildPacket(cmd, payload) {
  var d = [0x35, cmd]; for (var i = 0; i < payload.length; i++) d.push(payload[i]);
  d.push(d.reduce(function(s, v) { return (s + v) % 256; }, 0));
  return new Uint8Array(d);
}
function onBleNotify(e) {
  var d = e.target.value;
  if (d.getUint8(0) === 0x35 && d.getUint8(1) === 0x13 && d.byteLength >= 5) {
    var level = d.getUint8(3);
    document.getElementById('batText').textContent = level + '%';
    if (level < 20) showToast('电量低: ' + level + '%', 'warn');
  }
}

// --- Tab Switching ---
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.tabbar button').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById(tabId).classList.add('active');
  document.getElementById('tabBtn' + tabId.replace('tab', '')).classList.add('active');
  if (tabId === 'tabAI') setTimeout(initChart, 100);
}

// --- Theme Toggle --- (darkMode already declared above)
function toggleTheme() {
  darkMode = !darkMode;
  document.documentElement.classList.toggle('light', !darkMode);
  document.getElementById('themeBtn').textContent = darkMode ? '🌙' : '☀️';
  localStorage.setItem('theme', darkMode ? 'dark' : 'light');
}
(function() {
  var saved = localStorage.getItem('theme');
  if (saved === 'light') { darkMode = false; document.documentElement.classList.add('light'); }
})();

// --- Toast ---
function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.style.borderColor = type === 'ok' ? 'var(--green)' : type === 'err' ? 'var(--red)' : type === 'warn' ? 'var(--orange)' : 'var(--accent)';
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2000);
}

// --- Chart --- (chartCtx and intensityHistory already declared above)
var MAX_HIST = 200;
function initChart() {
  var c = document.getElementById('intensityChart');
  if (!c) return;
  c.width = c.offsetWidth * 2; c.height = c.offsetHeight * 2;
  chartCtx = c.getContext('2d');
}
function drawChart() {
  if (!chartCtx) return;
  var w = chartCtx.canvas.width, h = chartCtx.canvas.height;
  chartCtx.clearRect(0, 0, w, h);
  if (intensityHistory.length < 2) return;
  chartCtx.beginPath(); chartCtx.strokeStyle = '#7c3aed'; chartCtx.lineWidth = 2;
  var step = w / MAX_HIST, start = Math.max(0, intensityHistory.length - MAX_HIST);
  for (var i = start; i < intensityHistory.length; i++) {
    var x = (i - start) * step, y = h - (intensityHistory[i] / 100 * h);
    if (i === start) chartCtx.moveTo(x, y); else chartCtx.lineTo(x, y);
  }
  chartCtx.stroke();
}

// --- Personality Editor ---
function toggleEditor() { switchTab('tabPattern'); }
async function loadPersonalityForEdit() {
  var pid = document.getElementById('editPersonality').value;
  if (!pid) return;
  try {
    var r = await fetch('/api/personalities/' + pid);
    var data = await r.json();
    document.getElementById('editName').value = data.name || '';
    document.getElementById('editEmoji').value = data.emoji || '';
    document.getElementById('editId').value = data.id || '';
    document.getElementById('editDescription').value = data.description || '';
    document.getElementById('editTraits').value = JSON.stringify(data.traits || {}, null, 2);
    showToast('已加载: ' + data.name, 'ok');
  } catch(e) { showToast('加载失败', 'err'); }
}
async function savePersonality() {
  var pid = document.getElementById('editId').value;
  if (!pid) { showToast('请填写ID', 'err'); return; }
  var data = {id:pid, name:document.getElementById('editName').value||pid, emoji:document.getElementById('editEmoji').value||'🎭', description:document.getElementById('editDescription').value||'', traits:JSON.parse(document.getElementById('editTraits').value||'{}'), rules:[], channel_weights:{A:0.33,B:0.33,C:0.34}, pacing:{base_interval:[3,6],excitement_interval:[2,4]}};
  try { await fetch('/api/personalities/'+pid, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); showToast('已保存','ok'); loadPersonalities(); loadEditorList(); } catch(e) { showToast('保存失败','err'); }
}
async function createPersonality() {
  var pid = 'custom_' + Date.now();
  document.getElementById('editId').value = pid;
  document.getElementById('editName').value = '自定义';
  document.getElementById('editEmoji').value = '🎭';
  document.getElementById('editTraits').value = JSON.stringify({intensity_ceiling:0.7,tease_factor:0.5,patience:0.5,variety:0.5},null,2);
  showToast('新建人格，编辑后保存', 'info');
}
async function loadEditorList() {
  try { var r = await fetch('/api/personalities'); var data = await r.json(); var sel = document.getElementById('editPersonality'); sel.innerHTML = '<option value="">选择人格...</option>' + data.map(function(p) { return '<option value="'+p.id+'">'+p.emoji+' '+p.name+'</option>'; }).join(''); } catch(e) {}
}
// Initialization (run once)
loadPersonalities();
loadEditorList();
setTimeout(initChart, 500);
selectPattern('random');
addLog('info', '控制面板就绪');


// ─── Random Toggle ──────────────────────────────────
var randomRunning = false;
function toggleRandom() {
  var btn = document.getElementById('randomBtn');
  if (randomRunning) {
    // 总控：停设备+停AI
    socket_emit('stop_all', {});
    socket_emit('stop_ai', {});
    if (typeof bleChar !== 'undefined' && bleChar) bleWrite(0,0,0);
    randomRunning = false;
    aiRunning = false;
    updateAiUI();
    btn.textContent = '🎲 随机';
    btn.style.background = 'var(--orange)';
    btn.style.boxShadow = 'none';
    showToast('🎲 已停止（设备+AI）', 'warn');
    addChatBubble('🎲 随机模式已关闭，设备和AI已停止', false);
  } else {
    var restC = parseInt(document.getElementById('restChance').value) || 25;
    var rMin = parseInt(document.getElementById('randIntervalMin').value) || 2;
    var rMax = parseInt(document.getElementById('randIntervalMax').value) || 6;
    socket_emit('start_random', {interval: [rMin, rMax], rest_chance: restC / 100});
    randomRunning = true;
    btn.textContent = '🎲 停止中';
    btn.style.background = 'var(--red)';
    btn.style.boxShadow = '0 0 10px rgba(239,68,68,0.5)';
    showToast('🎲 随机启动', 'ok');
  }
}

// ─── Enhanced Emergency Stop ────────────────────────
var _origEmergencyStop = typeof emergencyStop === 'function' ? emergencyStop : null;
var _deviceStopped = false;
emergencyStop = function() {
  try {
    var dur = parseInt(document.getElementById('stopDuration') ? document.getElementById('stopDuration').value : 0) || 0;
    // 0秒 = 永久停止，再按恢复
    if (dur === 0) {
      if (_deviceStopped) {
        _deviceStopped = false;
        showToast('▶ 恢复运行', 'ok');
        return;
      }
      _deviceStopped = true;
      if (typeof bleChar !== 'undefined' && bleChar) { try { bleWrite(0,0,0); } catch(e){} }
      socket_emit('stop_all', {});
      socket_emit('stop_ai', {});
      aiRunning = false; randomRunning = false;
      updateAiUI();
      var btn = document.getElementById('randomBtn');
      if (btn) { btn.textContent = '🎲 随机'; btn.style.background = 'var(--orange)'; btn.style.boxShadow = 'none'; }
      showToast('🛑 永久停止 - 再按恢复', 'err');
    } else {
      // N秒 = 立即停，等N秒后自动恢复
      if (typeof bleChar !== 'undefined' && bleChar) { try { bleWrite(0,0,0); } catch(e){} }
      socket_emit('stop_all', {});
      socket_emit('stop_ai', {});
      aiRunning = false; randomRunning = false;
      updateAiUI();
      showToast('⏸ 暂停 ' + dur + '秒后恢复', 'warn');
      setTimeout(function() {
        // 恢复：重新启动当前人格AI
        var personality = document.getElementById('aiPersonality').value || 'balanced';
        var duration = parseInt(document.getElementById('aiDuration').value) || 1800;
        fetch('/api/cmd', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cmd:'start_ai',args:{personality_id:personality,max_duration:duration}})});
        aiRunning = true;
        updateAiUI();
        showToast('▶ 恢复运行 ' + personality, 'ok');
      }, dur * 1000);
    }
  } catch(e) { showToast('错误', 'err'); }
};

// ─── Settings ───────────────────────────────────────
async function loadSettings() {
  try {
    var r = await fetch('/api/settings');
    var d = await r.json();
    if (d.AI_API_KEY) document.getElementById('setApiKey').value = d.AI_API_KEY;
    if (d.AI_BASE_URL) document.getElementById('setBaseUrl').value = d.AI_BASE_URL;
    if (d.AI_MODEL) document.getElementById('setModel').value = d.AI_MODEL;
    if (d.BLE_DEVICE_NAME) document.getElementById('setDeviceName').value = d.BLE_DEVICE_NAME;
  } catch(e) {}
}
async function saveSettings() {
  var data = {};
  var key = document.getElementById('setApiKey').value;
  var url = document.getElementById('setBaseUrl').value;
  var model = document.getElementById('setModel').value;
  var name = document.getElementById('setDeviceName').value;
  if (key) data.AI_API_KEY = key;
  if (url) data.AI_BASE_URL = url;
  if (model) data.AI_MODEL = model;
  if (name) data.BLE_DEVICE_NAME = name;
  try {
    var r = await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    var d = await r.json();
    document.getElementById('settingsMsg').textContent = d.message || '已保存';
    showToast('💾 设置已保存，重启服务生效', 'ok');
  } catch(e) { showToast('保存失败', 'err'); }
}
loadSettings();
