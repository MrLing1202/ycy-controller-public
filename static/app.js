"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  bleDevice: null,
  bleServer: null,
  writeChar: null,
  notifyChar: null,
  connected: false,
  lastSpeeds: { a: 0, b: 0, c: 0 },
  audioCtx: null,
  analyser: null,
  sourceNode: null,
  mediaStream: null,
  mediaElementSource: null,
  audioRunning: false,
  raf: 0,
  writeTimer: 0,
  smoothIntensity: 0,
  lastLoudAt: 0,
  lastWriteAt: 0,
  lastManualAt: 0,
};

const CMD = {
  QUERY_INFO: 0x10,
  SET_MODE: 0x11,
  SET_SPEED: 0x12,
};

const MOTOR_CODE = { A: 0x01, B: 0x12, C: 0x14 };
const LIMITS = { a: [0, 40], b: [0, 20], c: [0, 20] };

function clamp(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function nowText() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function log(message, level = "info") {
  const line = `[${nowText()}] ${level.toUpperCase()} ${message}`;
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

function setBleStatus(connected, text) {
  state.connected = connected;
  const pill = $("bleStatus");
  const dot = pill.querySelector(".dot");
  const label = pill.querySelector("span:last-child");
  dot.classList.toggle("on", connected);
  dot.classList.toggle("off", !connected);
  label.textContent = text || (connected ? "已连接" : "未连接");
}

function checksum(bytes) {
  return bytes.reduce((s, b) => (s + b) & 0xff, 0);
}

function packet(cmd, payload = []) {
  const data = [0x35, cmd, ...payload.map((x) => x & 0xff)];
  data.push(checksum(data));
  return new Uint8Array(data);
}

function packetSetSpeed(a, b, c) {
  a = clamp(Math.round(a), 0, 40);
  b = clamp(Math.round(b), 0, 20);
  c = clamp(Math.round(c), 0, 20);
  return packet(CMD.SET_SPEED, [a, b, c]);
}

function packetSetMode(channel, mode) {
  const ch = String(channel || "").toUpperCase();
  const code = MOTOR_CODE[ch];
  if (!code) throw new Error(`无效通道 ${channel}`);
  return packet(CMD.SET_MODE, [code, clamp(Math.round(mode), 0, 7)]);
}

function packetStopAll() {
  return [
    packetSetSpeed(0, 0, 0),
    packetSetMode("A", 0),
    packetSetMode("B", 0),
    packetSetMode("C", 0),
  ];
}

async function bleWrite(bytes) {
  if (!state.writeChar) {
    if ($("demoMode").checked) return true;
    throw new Error("BLE 未连接");
  }
  await state.writeChar.writeValue(bytes);
  return true;
}

async function sendSpeed(a, b, c, reason = "manual", force = false) {
  a = clamp(Math.round(a), ...LIMITS.a);
  b = clamp(Math.round(b), ...LIMITS.b);
  c = clamp(Math.round(c), ...LIMITS.c);

  const same = state.lastSpeeds.a === a && state.lastSpeeds.b === b && state.lastSpeeds.c === c;
  if (same && !force) return;

  await bleWrite(packetSetSpeed(a, b, c));
  state.lastSpeeds = { a, b, c };
  $("speedText").textContent = `A${a} B${b} C${c}`;
  log(`速度 ${reason}: A=${a} B=${b} C=${c}`, reason === "stop" ? "warn" : "info");
}

async function emergencyStop(reason = "紧急停止") {
  state.audioRunning = false;
  cancelAnimationFrame(state.raf);
  clearInterval(state.writeTimer);
  state.smoothIntensity = 0;
  $("meterFill").style.width = "0%";
  $("intensityText").textContent = "0%";
  for (const p of packetStopAll()) {
    await bleWrite(p).catch((e) => log(`停止包发送失败：${e.message}`, "warn"));
    await new Promise((r) => setTimeout(r, 35));
  }
  state.lastSpeeds = { a: 0, b: 0, c: 0 };
  $("speedText").textContent = "A0 B0 C0";
  log(reason, "warn");
}

function handleNotify(event) {
  const data = new Uint8Array(event.target.value.buffer);
  const raw = Array.from(data).map((x) => x.toString(16).padStart(2, "0")).join(" ");
  log(`通知 ${raw}`);
}

async function loadConfig() {
  const res = await fetch("/api/config", { cache: "no-store" });
  state.config = await res.json();
  $("deviceName").value = state.config.device_name;
  $("serviceUuid").value = state.config.service_uuid;
  $("writeUuid").value = state.config.write_uuid;
  $("notifyUuid").value = state.config.notify_uuid;
  log("配置已载入");
}

async function connectBle() {
  if (!navigator.bluetooth) {
    log("当前浏览器不支持 Web Bluetooth，请使用新版 Chrome 或 Edge", "error");
    return;
  }
  const serviceUuid = $("serviceUuid").value.trim();
  const writeUuid = $("writeUuid").value.trim();
  const notifyUuid = $("notifyUuid").value.trim();
  const namePrefix = $("deviceName").value.trim();

  const filters = namePrefix ? [{ namePrefix }] : undefined;
  const options = filters
    ? { filters, optionalServices: [serviceUuid] }
    : { acceptAllDevices: true, optionalServices: [serviceUuid] };

  log("打开蓝牙选择器...");
  try {
    state.bleDevice = await navigator.bluetooth.requestDevice(options);
    state.bleDevice.addEventListener("gattserverdisconnected", onBleDisconnected);
    state.bleServer = await state.bleDevice.gatt.connect();
    const service = await state.bleServer.getPrimaryService(serviceUuid);
    state.writeChar = await service.getCharacteristic(writeUuid);
    try {
      state.notifyChar = await service.getCharacteristic(notifyUuid);
      await state.notifyChar.startNotifications();
      state.notifyChar.addEventListener("characteristicvaluechanged", handleNotify);
    } catch (e) {
      log(`通知通道未启用：${e.message}`, "warn");
    }
    setBleStatus(true, `BLE: ${state.bleDevice.name || "已连接"}`);
    $("demoMode").checked = false;
    log(`BLE 已连接：${state.bleDevice.name || "未知设备"}`, "ok");
  } catch (e) {
    setBleStatus(false, "连接失败");
    log(`BLE 连接失败：${e.message}`, "error");
  }
}

async function disconnectBle() {
  await emergencyStop("断开前已发送停止").catch(() => {});
  if (state.bleDevice?.gatt?.connected) state.bleDevice.gatt.disconnect();
  state.writeChar = null;
  state.notifyChar = null;
  setBleStatus(false, "未连接");
}

function onBleDisconnected() {
  state.writeChar = null;
  state.notifyChar = null;
  setBleStatus(false, "已断开");
  log("BLE 连接断开", "warn");
}

function fillModeOptions() {
  for (const id of ["modeA", "modeB", "modeC"]) {
    const sel = $(id);
    for (let i = 0; i <= 7; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = i === 0 ? "0 关闭" : `${i} 模式 ${i}`;
      sel.appendChild(opt);
    }
  }
}

function updateRangeOutputs() {
  const ids = [
    "manualA", "manualB", "manualC", "noiseFloor", "gain", "lowBoost", "minIntensity", "attack", "release", "writeHz", "silentStop",
    "maxA", "maxB", "maxC", "weightA", "weightB", "weightC"
  ];
  for (const id of ids) {
    const el = $(id);
    const out = $(`${id}Out`);
    if (!el || !out) continue;
    const value = Number(el.value);
    if (id.startsWith("weight")) out.textContent = value.toFixed(2);
    else if (["noiseFloor", "attack", "release", "silentStop", "gain", "lowBoost", "minIntensity"].includes(id)) out.textContent = value.toFixed(id === "noiseFloor" ? 4 : 2).replace(/0$/, "");
    else out.textContent = String(Math.round(value));
  }
  $("manualAOut").textContent = $("manualA").value;
  $("manualBOut").textContent = $("manualB").value;
  $("manualCOut").textContent = $("manualC").value;
}

function readMappingConfig() {
  return {
    noiseFloor: Number($("noiseFloor").value),
    gain: Number($("gain").value),
    lowBoost: Number($("lowBoost").value),
    minIntensity: Number($("minIntensity").value),
    attack: Number($("attack").value),
    release: Number($("release").value),
    writeHz: Number($("writeHz").value),
    silentStop: Number($("silentStop").value),
    enableA: $("enableA").checked,
    enableB: $("enableB").checked,
    enableC: $("enableC").checked,
    maxA: Number($("maxA").value),
    maxB: Number($("maxB").value),
    maxC: Number($("maxC").value),
    weightA: Number($("weightA").value),
    weightB: Number($("weightB").value),
    weightC: Number($("weightC").value),
  };
}

function computeRms() {
  if (!state.analyser) return 0;
  const data = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const x of data) {
    const v = (x - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function loudnessToIntensity(rms, cfg) {
  const floor = clamp(cfg.noiseFloor, 0, 0.2);
  const softFloor = floor * 0.35;
  if (rms <= softFloor) return 0;

  let x;
  if (rms < floor) {
    // 门限附近做软启动，避免小声音被硬切成 0。
    const t = (rms - softFloor) / Math.max(0.0001, floor - softFloor);
    x = t * 0.035 * cfg.gain;
  } else {
    x = (rms - floor) * cfg.gain;
  }

  x = clamp(x, 0, 1);
  // gamma < 1 会抬升小声音细节；值越小，小声音越容易有强度。
  const gamma = clamp(cfg.lowBoost || 0.45, 0.2, 1);
  const boosted = Math.pow(x, gamma);
  let y = 1 - Math.exp(-2.2 * boosted);
  if (y > 0 && cfg.minIntensity > 0) y = Math.max(y, cfg.minIntensity);
  return clamp(y, 0, 1);
}

function intensityToSpeeds(intensity, cfg) {
  // 旧 smoothstep 会把 0.05 这种小强度压得更小，导致 round 后全是 0。
  // 新曲线保留弱声细节，同时高强度仍然平滑。
  const curve = 0.45 * intensity + 0.55 * Math.pow(intensity, 1.35);
  const a = cfg.enableA ? Math.round(cfg.maxA * cfg.weightA * curve) : 0;
  const b = cfg.enableB ? Math.round(cfg.maxB * cfg.weightB * curve) : 0;
  const c = cfg.enableC ? Math.round(cfg.maxC * cfg.weightC * curve) : 0;
  return { a: clamp(a, 0, 40), b: clamp(b, 0, 20), c: clamp(c, 0, 20) };
}

function audioLoop() {
  if (!state.audioRunning) return;
  const cfg = readMappingConfig();
  const rms = computeRms();
  const target = loudnessToIntensity(rms, cfg);
  const alpha = target > state.smoothIntensity ? cfg.attack : cfg.release;
  state.smoothIntensity += (target - state.smoothIntensity) * alpha;

  if (target > 0.02) state.lastLoudAt = performance.now();
  if (performance.now() - state.lastLoudAt > cfg.silentStop * 1000) state.smoothIntensity *= 0.55;
  if (state.smoothIntensity < 0.005) state.smoothIntensity = 0;

  $("rmsText").textContent = rms.toFixed(3);
  $("intensityText").textContent = `${Math.round(state.smoothIntensity * 100)}%`;
  $("meterFill").style.width = `${Math.round(state.smoothIntensity * 100)}%`;
  state.raf = requestAnimationFrame(audioLoop);
}

async function setupMediaElementSource() {
  const media = $("mediaPlayer");
  if (!media.src) throw new Error("请先选择并播放本地视频/音频");
  state.audioCtx = state.audioCtx || new AudioContext();
  if (!state.mediaElementSource) {
    state.mediaElementSource = state.audioCtx.createMediaElementSource(media);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 2048;
    state.mediaElementSource.connect(state.analyser);
    state.analyser.connect(state.audioCtx.destination);
  }
  await state.audioCtx.resume();
}

async function setupScreenAudioSource() {
  state.audioCtx = state.audioCtx || new AudioContext();
  if (!state.mediaStream) {
    throw new Error("请先捕获屏幕/标签页声音");
  }
  const audioTracks = state.mediaStream.getAudioTracks();
  if (!audioTracks.length) throw new Error("没有捕获到音频轨道，选择共享时需要勾选音频");
  if (state.sourceNode) state.sourceNode.disconnect();
  state.sourceNode = state.audioCtx.createMediaStreamSource(state.mediaStream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 2048;
  state.sourceNode.connect(state.analyser);
  await state.audioCtx.resume();
}

function activeAudioTab() {
  return document.querySelector(".tab.active")?.dataset.audioTab || "file";
}

async function startAudioReactive() {
  if (!state.writeChar && !$("demoMode").checked) {
    log("未连接 BLE。可先连接设备，或勾选模拟模式测试。", "error");
    return;
  }
  try {
    if (activeAudioTab() === "screen") await setupScreenAudioSource();
    else await setupMediaElementSource();

    state.audioRunning = true;
    state.smoothIntensity = 0;
    state.lastLoudAt = performance.now();
    cancelAnimationFrame(state.raf);
    clearInterval(state.writeTimer);
    audioLoop();

    const tick = async () => {
      if (!state.audioRunning) return;
      const cfg = readMappingConfig();
      const speeds = intensityToSpeeds(state.smoothIntensity, cfg);
      try {
        await sendSpeed(speeds.a, speeds.b, speeds.c, "audio");
      } catch (e) {
        log(`音频跟随发送失败：${e.message}`, "error");
        state.audioRunning = false;
      }
    };
    const interval = Math.max(80, Math.round(1000 / readMappingConfig().writeHz));
    state.writeTimer = setInterval(tick, interval);
    await tick();
    log("音频跟随已启动", "ok");
  } catch (e) {
    state.audioRunning = false;
    log(`音频跟随启动失败：${e.message}`, "error");
  }
}

async function stopAudioReactive() {
  state.audioRunning = false;
  cancelAnimationFrame(state.raf);
  clearInterval(state.writeTimer);
  state.smoothIntensity = 0;
  $("meterFill").style.width = "0%";
  $("intensityText").textContent = "0%";
  await sendSpeed(0, 0, 0, "stop", true).catch((e) => log(`停止失败：${e.message}`, "warn"));
  log("音频跟随已停止", "warn");
}

function bindEvents() {
  $("btnConnect").addEventListener("click", connectBle);
  $("btnDisconnect").addEventListener("click", disconnectBle);
  $("btnStop").addEventListener("click", () => emergencyStop());
  $("btnSendManual").addEventListener("click", () => sendSpeed($("manualA").value, $("manualB").value, $("manualC").value, "manual", true));
  $("btnClearLog").addEventListener("click", () => { $("log").textContent = ""; });

  for (const id of ["manualA", "manualB", "manualC", "noiseFloor", "gain", "lowBoost", "minIntensity", "attack", "release", "writeHz", "silentStop", "maxA", "maxB", "maxC", "weightA", "weightB", "weightC"]) {
    $(id).addEventListener("input", updateRangeOutputs);
  }

  for (const btn of document.querySelectorAll(".soft-stop")) {
    btn.addEventListener("click", async () => {
      const ch = btn.dataset.ch.toLowerCase();
      const next = { ...state.lastSpeeds, [ch]: 0 };
      await sendSpeed(next.a, next.b, next.c, `stop-${btn.dataset.ch}`, true);
    });
  }

  for (const [id, ch] of [["modeA", "A"], ["modeB", "B"], ["modeC", "C"]]) {
    $(id).addEventListener("change", async () => {
      const mode = Number($(id).value);
      try {
        await bleWrite(packetSetMode(ch, mode));
        log(`模式 ${ch}=${mode}`);
      } catch (e) {
        log(`模式发送失败：${e.message}`, "error");
      }
    });
  }

  $("mediaFile").addEventListener("change", () => {
    const file = $("mediaFile").files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    $("mediaPlayer").src = url;
    state.mediaElementSource = null;
    log(`已载入媒体：${file.name}`);
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      const name = tab.dataset.audioTab;
      $(name === "file" ? "tabFile" : "tabScreen").classList.add("active");
    });
  }

  $("btnCaptureAudio").addEventListener("click", async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("浏览器不支持屏幕音频捕获");
      if (state.mediaStream) state.mediaStream.getTracks().forEach((t) => t.stop());
      state.mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      $("screenPreview").srcObject = state.mediaStream;
      const tracks = state.mediaStream.getAudioTracks();
      log(tracks.length ? "已捕获屏幕/标签页音频" : "未捕获到音频轨道，请重新选择并勾选共享音频", tracks.length ? "ok" : "warn");
    } catch (e) {
      log(`捕获失败：${e.message}`, "error");
    }
  });

  $("btnStartAudio").addEventListener("click", startAudioReactive);
  $("btnStopAudio").addEventListener("click", stopAudioReactive);
  $("btnCalibrate").addEventListener("click", () => {
    const rms = computeRms();
    const value = clamp(Math.max(0.001, rms * 0.75), 0, 0.08);
    $("noiseFloor").value = String(value);
    updateRangeOutputs();
    log(`已将静音阈值校准为 ${value.toFixed(4)}，小声音不会再被整段切掉`);
  });

  window.addEventListener("beforeunload", () => {
    if (state.connected) {
      // beforeunload 里不能 await，只做尽力停止。
      bleWrite(packetSetSpeed(0, 0, 0)).catch(() => {});
    }
  });
}

async function boot() {
  fillModeOptions();
  updateRangeOutputs();
  bindEvents();
  await loadConfig();
  if (!navigator.bluetooth) log("提示：当前浏览器可能不支持 Web Bluetooth。请用 Chrome 或 Edge 打开 localhost。", "warn");
  log("程序就绪：先连接 BLE，或用模拟模式测试音频映射。", "ok");
}

boot().catch((e) => log(`启动失败：${e.message}`, "error"));
