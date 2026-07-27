
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
  document.getElementById('dot').className = 'dot ' + (s.connected ? 'on' : 'off');
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
    var stream = await navigator.mediaDevices.getUserMedia({audio: true});
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
// ─── Voice Analyzer Engine (Frontend Local) ───────────
// 双层架构：
//   Layer1(前端): 本地五维评分 + 即时BLE停止 → 零延迟安全层
//   Layer2(服务端): 接收数据 + AI通知 + 日志 → 智能协同层
var voiceEngine = {
  // 配置（与服务端 VoiceConfig 保持一致）
  cfg: {
    weight_volume: 0.30, weight_pitch: 0.15, weight_density: 0.25,
    weight_urgency: 0.15, weight_sustain: 0.15,
    volume_floor: 5, volume_ceiling: 80, volume_peak: 60,
    pitch_floor: 100, pitch_ceiling: 1200, pitch_boost: 600,
    density_window: 5, density_max: 12, density_min: 2,
    urgency_window: 10, urgency_max_slope: 8, urgency_decay: 0.92,
    sustain_threshold: 40, sustain_full: 4, sustain_decay: 0.97,
    climax_threshold: 72, climax_hold: 1.2, cooldown: 15,
    min_frames: 15
  },
  // 状态
  frames: [],          // {vol, pitch, ts}
  vocalEvents: [],     // 发声事件时间戳
  sustainAccum: 0,
  urgencyScore: 0,
  aboveSince: null,
  lastTrigger: 0,
  totalScore: 0,
  dims: {volume:0, pitch:0, density:0, urgency:0, sustain:0},
  triggered: false,

  reset: function() {
    this.frames = []; this.vocalEvents = [];
    this.sustainAccum = 0; this.urgencyScore = 0;
    this.aboveSince = null; this.totalScore = 0;
    this.dims = {volume:0, pitch:0, density:0, urgency:0, sustain:0};
    this.triggered = false;
  },

  process: function(vol, pitch) {
    var now = Date.now() / 1000;
    var c = this.cfg;
    this.frames.push({vol:vol, pitch:pitch, ts:now});
    if (this.frames.length > 200) this.frames.shift();
    if (vol > c.volume_peak) this.vocalEvents.push(now);
    // 清理过期事件
    var wStart = now - c.density_window;
    while (this.vocalEvents.length && this.vocalEvents[0] < wStart) this.vocalEvents.shift();
    if (this.frames.length < c.min_frames) return;

    // ── 维度1: 音量强度 ──
    var recent = this.frames.slice(-5);
    var avgVol = recent.reduce(function(s,f){return s+f.vol;},0) / recent.length;
    var dVol = Math.max(0, Math.min(1, (avgVol - c.volume_floor) / (c.volume_ceiling - c.volume_floor)));

    // ── 维度2: 音调高度 ──
    var dPitch = 0;
    if (vol > c.volume_floor && pitch > c.pitch_floor) {
      dPitch = Math.max(0, Math.min(1, (pitch - c.pitch_floor) / (c.pitch_ceiling - c.pitch_floor)));
      if (pitch > c.pitch_boost) dPitch = Math.min(1, dPitch * 1.2);
    }

    // ── 维度3: 密集度 ──
    var count = this.vocalEvents.length;
    var dDensity = count < c.density_min ? 0 :
      Math.max(0, Math.min(1, (count - c.density_min) / (c.density_max - c.density_min)));

    // ── 维度4: 急促性 ──
    var n = Math.min(c.urgency_window, this.frames.length);
    var fSlice = this.frames.slice(-n);
    var dt = fSlice[fSlice.length-1].ts - fSlice[0].ts;
    if (dt < 0.01) dt = 0.1;
    var dv = fSlice[fSlice.length-1].vol - fSlice[0].vol;
    var slope = Math.max(0, dv / dt);
    var instant = Math.min(1, slope / c.urgency_max_slope);
    if (instant > this.urgencyScore) this.urgencyScore += (instant - this.urgencyScore) * 0.6;
    else this.urgencyScore *= c.urgency_decay;
    var dUrgency = this.urgencyScore;

    // ── 维度5: 持续性 ──
    if (vol > c.sustain_threshold) this.sustainAccum += 0.1;
    else this.sustainAccum *= c.sustain_decay;
    var dSustain = Math.max(0, Math.min(1, this.sustainAccum / c.sustain_full));

    this.dims = {volume:dVol, pitch:dPitch, density:dDensity, urgency:dUrgency, sustain:dSustain};

    // ── 加权综合评分 ──
    this.totalScore = Math.min(100, (
      dVol * c.weight_volume + dPitch * c.weight_pitch +
      dDensity * c.weight_density + dUrgency * c.weight_urgency +
      dSustain * c.weight_sustain
    ) * 100);

    // ── 触发判定 ──
    this._checkTrigger(now);
  },

  _checkTrigger: function(now) {
    var c = this.cfg;
    // 冷却期
    if (now - this.lastTrigger < c.cooldown) { this.aboveSince = null; return; }
    if (this.totalScore >= c.climax_threshold) {
      if (!this.aboveSince) this.aboveSince = now;
      if (now - this.aboveSince >= c.climax_hold) this._fire(now);
    } else {
      if (this.totalScore < c.climax_threshold * 0.85) this.aboveSince = null;
    }
  },

  _fire: function(now) {
    this.lastTrigger = now;
    this.aboveSince = null;
    this.triggered = true;
    this.sustainAccum = 0;
    this.urgencyScore = 0;
    // ══ Layer1: 前端即时停止（零延迟）══
    if (bleChar) { bleWrite(0, 0, 0); }  // Web Bluetooth 直停
    socket_emit('set_speed', {a:0, b:0, c:0});  // 服务端BLE停
    // ══ 通知 Layer2: 服务端 AI + 日志 ══
    socket_emit('voice_climax_triggered', {
      score: Math.round(this.totalScore),
      dims: this.dims,
      sustain: this.sustainAccum,
      timestamp: now
    });
    showToast('🛑 声音寸止触发！设备已停止', 'err');
    addLog('err', '🎤 声音寸止触发! 评分=' + Math.round(this.totalScore));
    // 同步停止AI/随机/音频跟随
    if (aiRunning) { socket_emit('stop_ai', {}); aiRunning = false; updateAiUI(); }
    if (typeof randomRunning !== 'undefined' && randomRunning) {
      randomRunning = false;
      var rb = document.getElementById('randomBtn');
      if (rb) { rb.textContent = '🎲 随机'; rb.style.background = 'var(--orange)'; rb.style.boxShadow = 'none'; }
    }
    if (typeof audioReactive !== 'undefined' && audioReactive.running) arStop();
  }
};

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
    document.getElementById('voicePanel').style.display = 'none';
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
    voiceEngine.reset();
    document.getElementById('micBtn').classList.add('active');
    document.getElementById('micBtn').textContent = '🎤●';
    document.getElementById('voicePanel').style.display = 'block';
    showToast('🎤 声纹监听已开启（本地引擎）', 'ok');
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

      // ══ Layer1: 本地实时分析 + 判定 ══
      voiceEngine.process(vol, pitch);

      // ══ Layer2: 同步发送服务端（AI协同+日志）══
      socket_emit('voice_data', {volume: vol, pitch: pitch, timestamp: Date.now() / 1000});

      // ══ 本地UI更新（零延迟）══
      document.getElementById('micMeter').style.width = vol + '%';
      document.getElementById('micMeter').style.background = vol > 70 ? 'var(--red)' : vol > 40 ? 'var(--orange)' : 'var(--green)';
      // 寸止面板
      var score = voiceEngine.totalScore;
      document.getElementById('voiceScoreBar').style.width = score + '%';
      document.getElementById('voiceScoreText').textContent = Math.round(score);
      var d = voiceEngine.dims;
      document.getElementById('vDimVol').textContent = Math.round(d.volume * 100);
      document.getElementById('vDimPitch').textContent = Math.round(d.pitch * 100);
      document.getElementById('vDimDensity').textContent = Math.round(d.density * 100);
      document.getElementById('vDimUrgency').textContent = Math.round(d.urgency * 100);
      document.getElementById('vDimSustain').textContent = Math.round(d.sustain * 100);
      document.getElementById('vEvents').textContent = voiceEngine.vocalEvents.length;
      document.getElementById('vSustain').textContent = voiceEngine.sustainAccum.toFixed(1) + 's';
      var statusEl = document.getElementById('vStatus');
      var coolRemain = voiceEngine.cfg.cooldown - (Date.now()/1000 - voiceEngine.lastTrigger);
      if (coolRemain > 0 && voiceEngine.lastTrigger > 0) {
        statusEl.textContent = '❄ 冷却 ' + Math.ceil(coolRemain) + 's';
        statusEl.style.color = 'var(--blue)';
      } else if (voiceEngine.aboveSince) {
        statusEl.textContent = '⚠ 接近临界!';
        statusEl.style.color = 'var(--red)';
      } else if (score > 50) {
        statusEl.textContent = '● 强度上升';
        statusEl.style.color = 'var(--orange)';
      } else {
        statusEl.textContent = '● 监听中';
        statusEl.style.color = 'var(--green)';
      }
    }, 100);
  } catch(e) { showToast('麦克风权限拒绝', 'err'); }
}

// 服务端寸止事件回显（备用，当服务端先触发时）
socket_on('voice_state', function(d) {
  // 仅当本地引擎未活跃时才用服务端数据更新UI
  if (micActive) return;
  var score = d.score || 0;
  document.getElementById('voiceScoreBar').style.width = score + '%';
  document.getElementById('voiceScoreText').textContent = Math.round(score);
});

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

// ─── Audio Reactive Controller ─────────────────────
// 音频响应模式：分析视频/屏幕声音响度，实时映射到 A/B/C 通道
var audioReactive = {
  running: false,
  audioCtx: null,
  analyser: null,
  sourceNode: null,
  mediaStream: null,
  mediaElementSource: null,
  raf: 0,
  writeTimer: 0,
  smoothIntensity: 0,
  lastLoudAt: 0,
};

function arClamp(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function arLog(msg, level) {
  addLog(level || 'info', '🎵 ' + msg);
}

function arReadConfig() {
  return {
    noiseFloor: Number(document.getElementById('arNoiseFloor').value),
    gain: Number(document.getElementById('arGain').value),
    lowBoost: Number(document.getElementById('arLowBoost').value),
    minIntensity: Number(document.getElementById('arMinIntensity').value),
    attack: Number(document.getElementById('arAttack').value),
    release: Number(document.getElementById('arRelease').value),
    writeHz: Number(document.getElementById('arWriteHz').value),
    silentStop: Number(document.getElementById('arSilentStop').value),
    enableA: document.getElementById('arEnableA').checked,
    enableB: document.getElementById('arEnableB').checked,
    enableC: document.getElementById('arEnableC').checked,
    maxA: Number(document.getElementById('arMaxA').value),
    maxB: Number(document.getElementById('arMaxB').value),
    maxC: Number(document.getElementById('arMaxC').value),
    weightA: Number(document.getElementById('arWeightA').value),
    weightB: Number(document.getElementById('arWeightB').value),
    weightC: Number(document.getElementById('arWeightC').value),
  };
}

function arUpdateOutputs() {
  var ids = ['arNoiseFloor','arGain','arLowBoost','arMinIntensity','arAttack','arRelease','arWriteHz','arSilentStop','arMaxA','arMaxB','arMaxC','arWeightA','arWeightB','arWeightC'];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    var out = document.getElementById(id + 'Out');
    if (!el || !out) return;
    var v = Number(el.value);
    if (id.indexOf('weight') >= 0 || id.indexOf('Weight') >= 0) out.textContent = v.toFixed(2);
    else if (['arNoiseFloor','arAttack','arRelease','arSilentStop','arGain','arLowBoost','arMinIntensity'].indexOf(id) >= 0) out.textContent = v.toFixed(id === 'arNoiseFloor' ? 4 : 2).replace(/0$/, '');
    else out.textContent = String(Math.round(v));
  });
}

function arComputeRms() {
  if (!audioReactive.analyser) return 0;
  var data = new Uint8Array(audioReactive.analyser.fftSize);
  audioReactive.analyser.getByteTimeDomainData(data);
  var sum = 0;
  for (var i = 0; i < data.length; i++) {
    var v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function arLoudnessToIntensity(rms, cfg) {
  var floor = arClamp(cfg.noiseFloor, 0, 0.2);
  var softFloor = floor * 0.35;
  if (rms <= softFloor) return 0;
  var x;
  if (rms < floor) {
    var t = (rms - softFloor) / Math.max(0.0001, floor - softFloor);
    x = t * 0.035 * cfg.gain;
  } else {
    x = (rms - floor) * cfg.gain;
  }
  x = arClamp(x, 0, 1);
  var gamma = arClamp(cfg.lowBoost || 0.45, 0.2, 1);
  var boosted = Math.pow(x, gamma);
  var y = 1 - Math.exp(-2.2 * boosted);
  if (y > 0 && cfg.minIntensity > 0) y = Math.max(y, cfg.minIntensity);
  return arClamp(y, 0, 1);
}

function arIntensityToSpeeds(intensity, cfg) {
  var curve = 0.45 * intensity + 0.55 * Math.pow(intensity, 1.35);
  var a = cfg.enableA ? Math.round(cfg.maxA * cfg.weightA * curve) : 0;
  var b = cfg.enableB ? Math.round(cfg.maxB * cfg.weightB * curve) : 0;
  var c = cfg.enableC ? Math.round(cfg.maxC * cfg.weightC * curve) : 0;
  return { a: arClamp(a, 0, 40), b: arClamp(b, 0, 20), c: arClamp(c, 0, 20) };
}

function arAudioLoop() {
  if (!audioReactive.running) return;
  var cfg = arReadConfig();
  var rms = arComputeRms();
  var target = arLoudnessToIntensity(rms, cfg);
  var alpha = target > audioReactive.smoothIntensity ? cfg.attack : cfg.release;
  audioReactive.smoothIntensity += (target - audioReactive.smoothIntensity) * alpha;
  if (target > 0.02) audioReactive.lastLoudAt = performance.now();
  if (performance.now() - audioReactive.lastLoudAt > cfg.silentStop * 1000) audioReactive.smoothIntensity *= 0.55;
  if (audioReactive.smoothIntensity < 0.005) audioReactive.smoothIntensity = 0;
  var rmsEl = document.getElementById('arRmsText');
  var intEl = document.getElementById('arIntensityText');
  var fillEl = document.getElementById('arMeterFill');
  if (rmsEl) rmsEl.textContent = rms.toFixed(3);
  if (intEl) intEl.textContent = Math.round(audioReactive.smoothIntensity * 100) + '%';
  if (fillEl) fillEl.style.width = Math.round(audioReactive.smoothIntensity * 100) + '%';
  audioReactive.raf = requestAnimationFrame(arAudioLoop);
}

function arActiveTab() {
  var active = document.querySelector('.ar-tab.active');
  return active ? active.dataset.arTab : 'file';
}

async function arSetupFileSource() {
  var media = document.getElementById('arMediaPlayer');
  if (!media.src) throw new Error('请先选择本地视频/音频文件');
  audioReactive.audioCtx = audioReactive.audioCtx || new AudioContext();
  if (!audioReactive.mediaElementSource) {
    audioReactive.mediaElementSource = audioReactive.audioCtx.createMediaElementSource(media);
    audioReactive.analyser = audioReactive.audioCtx.createAnalyser();
    audioReactive.analyser.fftSize = 2048;
    audioReactive.mediaElementSource.connect(audioReactive.analyser);
    audioReactive.analyser.connect(audioReactive.audioCtx.destination);
  }
  await audioReactive.audioCtx.resume();
}

async function arSetupScreenSource() {
  audioReactive.audioCtx = audioReactive.audioCtx || new AudioContext();
  if (!audioReactive.mediaStream) throw new Error('请先点击"捕获屏幕声音"');
  var tracks = audioReactive.mediaStream.getAudioTracks();
  if (!tracks.length) throw new Error('没有音频轨道，共享时需勾选音频');
  if (audioReactive.sourceNode) audioReactive.sourceNode.disconnect();
  audioReactive.sourceNode = audioReactive.audioCtx.createMediaStreamSource(audioReactive.mediaStream);
  audioReactive.analyser = audioReactive.audioCtx.createAnalyser();
  audioReactive.analyser.fftSize = 2048;
  audioReactive.sourceNode.connect(audioReactive.analyser);
  await audioReactive.audioCtx.resume();
}

async function arStart() {
  if (audioReactive.running) return;
  var demoMode = document.getElementById('arDemoMode') && document.getElementById('arDemoMode').checked;
  if (!bleChar && !isConnected && !demoMode) {
    arLog('未连接设备。请连接BLE或勾选模拟模式', 'err');
    showToast('请先连接设备或勾选模拟', 'err');
    return;
  }
  try {
    if (arActiveTab() === 'screen') await arSetupScreenSource();
    else await arSetupFileSource();
    audioReactive.running = true;
    audioReactive.smoothIntensity = 0;
    audioReactive.lastLoudAt = performance.now();
    cancelAnimationFrame(audioReactive.raf);
    clearInterval(audioReactive.writeTimer);
    arAudioLoop();
    var tick = async function() {
      if (!audioReactive.running) return;
      var cfg = arReadConfig();
      var speeds = arIntensityToSpeeds(audioReactive.smoothIntensity, cfg);
      try {
        if (bleChar) { bleWrite(speeds.a, speeds.b, speeds.c); }
        else if (!demoMode) {
          fetch('/api/cmd', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cmd:'set_speed', args:{a:speeds.a, b:speeds.b, c:speeds.c}})});
        }
        var spdEl = document.getElementById('arSpeedText');
        if (spdEl) spdEl.textContent = 'A' + speeds.a + ' B' + speeds.b + ' C' + speeds.c;
        // 同步更新手动滑条显示
        document.getElementById('sliderA').value = speeds.a / 40 * 100;
        document.getElementById('valA').textContent = speeds.a;
        document.getElementById('sliderB').value = speeds.b / 20 * 100;
        document.getElementById('valB').textContent = speeds.b;
        document.getElementById('sliderC').value = speeds.c / 20 * 100;
        document.getElementById('valC').textContent = speeds.c;
        updateSpeedBars(speeds.a, speeds.b, speeds.c);
      } catch(e) {
        arLog('发送失败: ' + e.message, 'err');
        audioReactive.running = false;
      }
    };
    var interval = Math.max(80, Math.round(1000 / arReadConfig().writeHz));
    audioReactive.writeTimer = setInterval(tick, interval);
    await tick();
    arLog('音频跟随已启动', 'ok');
    showToast('🎵 音频跟随已启动', 'ok');
    var btn = document.getElementById('arBtnStart');
    if (btn) { btn.textContent = '⏹ 停止跟随'; btn.className = 'btn btn-d'; }
  } catch(e) {
    audioReactive.running = false;
    arLog('启动失败: ' + e.message, 'err');
    showToast('音频跟随启动失败', 'err');
  }
}

async function arStop() {
  audioReactive.running = false;
  cancelAnimationFrame(audioReactive.raf);
  clearInterval(audioReactive.writeTimer);
  audioReactive.smoothIntensity = 0;
  var fillEl = document.getElementById('arMeterFill');
  var intEl = document.getElementById('arIntensityText');
  if (fillEl) fillEl.style.width = '0%';
  if (intEl) intEl.textContent = '0%';
  if (bleChar) bleWrite(0, 0, 0);
  else socket_emit('set_speed', {a:0, b:0, c:0});
  arLog('音频跟随已停止', 'warn');
  showToast('🎵 音频跟随已停止', 'warn');
  var btn = document.getElementById('arBtnStart');
  if (btn) { btn.textContent = '▶ 启动跟随'; btn.className = 'btn btn-s'; }
}

function arToggle() {
  if (audioReactive.running) arStop();
  else arStart();
}

function arCalibrate() {
  var rms = arComputeRms();
  var value = arClamp(Math.max(0.001, rms * 0.75), 0, 0.08);
  document.getElementById('arNoiseFloor').value = String(value);
  arUpdateOutputs();
  arLog('静音阈值校准为 ' + value.toFixed(4));
  showToast('已校准静音阈值: ' + value.toFixed(4), 'ok');
}

function arSwitchTab(tab) {
  document.querySelectorAll('.ar-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.ar-panel').forEach(function(p) { p.classList.remove('active'); });
  var btn = document.querySelector('.ar-tab[data-ar-tab="' + tab + '"]');
  if (btn) btn.classList.add('active');
  document.getElementById(tab === 'file' ? 'arTabFile' : 'arTabScreen').classList.add('active');
}

function arInit() {
  // 绑定文件选择
  var fileInput = document.getElementById('arMediaFile');
  if (fileInput) {
    fileInput.addEventListener('change', function() {
      var file = fileInput.files[0];
      if (!file) return;
      var url = URL.createObjectURL(file);
      document.getElementById('arMediaPlayer').src = url;
      audioReactive.mediaElementSource = null;
      arLog('已载入: ' + file.name);
      showToast('已载入: ' + file.name, 'ok');
    });
  }
  // 绑定屏幕捕获
  var capBtn = document.getElementById('arBtnCapture');
  if (capBtn) {
    capBtn.addEventListener('click', async function() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('浏览器不支持');
        if (audioReactive.mediaStream) audioReactive.mediaStream.getTracks().forEach(function(t) { t.stop(); });
        audioReactive.mediaStream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: true});
        var preview = document.getElementById('arScreenPreview');
        if (preview) preview.srcObject = audioReactive.mediaStream;
        var tracks = audioReactive.mediaStream.getAudioTracks();
        arLog(tracks.length ? '已捕获屏幕音频' : '未捕获到音频轨道', tracks.length ? 'ok' : 'warn');
        showToast(tracks.length ? '已捕获屏幕音频' : '未捕获到音频', tracks.length ? 'ok' : 'warn');
      } catch(e) { arLog('捕获失败: ' + e.message, 'err'); }
    });
  }
  // 绑定参数滑条
  var sliderIds = ['arNoiseFloor','arGain','arLowBoost','arMinIntensity','arAttack','arRelease','arWriteHz','arSilentStop','arMaxA','arMaxB','arMaxC','arWeightA','arWeightB','arWeightC'];
  sliderIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', arUpdateOutputs);
  });
  arUpdateOutputs();
}
arInit();
