"""声音寸止分析器
================
实时分析前端发来的麦克风数据（volume/pitch/timestamp），
通过多维度加权评分判断用户是否接近高潮，触发设备紧急停止。

评审维度：
  1. 音量强度 (volume_intensity)  — 声音越大越接近
  2. 音调高度 (pitch_height)     — 音调越高越激烈
  3. 密集度   (density)          — 发声越密集（间隔越短）越接近
  4. 急促性   (urgency)          — 音量上升速率越快越紧急
  5. 持续性   (sustain)          — 高强度持续越久越接近临界

触发逻辑：
  综合评分 = Σ(维度分数 × 权重) → 0~100
  当评分连续 exceed_threshold 秒超过 climax_threshold → 触发寸止
  触发后进入 cooldown 冷却期，避免重复触发
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional, Tuple

logger = logging.getLogger("ycy.voice")


# ─── 配置 ──────────────────────────────────────────────────

@dataclass
class VoiceConfig:
    """声音寸止评审参数配置

    所有阈值和权重均可根据实际体验调整。
    """

    # ── 维度权重（总和应为 1.0）──
    weight_volume: float = 0.30       # 音量强度权重
    weight_pitch: float = 0.15        # 音调高度权重
    weight_density: float = 0.25      # 密集度权重
    weight_urgency: float = 0.15      # 急促性（变化速率）权重
    weight_sustain: float = 0.15      # 持续性权重

    # ── 音量参数 ──
    volume_floor: float = 5.0         # 低于此值视为静音（前端范围 0-100）
    volume_ceiling: float = 80.0      # 高于此值视为满分
    volume_peak_threshold: float = 60.0  # 超过此值记为一次"发声事件"

    # ── 音调参数 ──
    pitch_floor: float = 100.0        # Hz，低于此视为底噪/呼吸
    pitch_ceiling: float = 1200.0     # Hz，高于此视为满分（尖叫）
    pitch_weight_above: float = 600.0 # Hz，超过此频率额外加分

    # ── 密集度参数 ──
    density_window: float = 5.0       # 统计窗口（秒）
    density_max_events: float = 12.0  # 窗口内达到此次数视为满分
    density_min_events: float = 2.0   # 低于此次数视为0分

    # ── 急促性参数 ──
    urgency_window: int = 10          # 用最近N帧计算斜率
    urgency_max_slope: float = 8.0    # 音量上升斜率满分阈值（单位/秒）
    urgency_decay: float = 0.92       # 急促度衰减系数（每帧）

    # ── 持续性参数 ──
    sustain_threshold: float = 40.0   # 音量超过此值开始累积持续时间
    sustain_full_seconds: float = 4.0 # 持续N秒视为满分
    sustain_decay: float = 0.97       # 低于阈值时的衰减

    # ── 触发判定 ──
    climax_threshold: float = 72.0    # 综合评分超过此值开始计时
    climax_hold_seconds: float = 1.2  # 连续超过阈值N秒后触发
    cooldown_seconds: float = 15.0    # 触发后冷却期（秒）

    # ── 安全 ──
    min_data_points: int = 15         # 至少收集N帧后才开始判定
    stale_timeout: float = 3.0        # 超过N秒无数据则重置状态


# ─── 数据帧 ──────────────────────────────────────────────────

@dataclass
class AudioFrame:
    volume: float       # 0-100
    pitch: float        # Hz
    timestamp: float    # 秒级时间戳
    is_vocal: bool = False  # 是否为有效发声


# ─── 分析器 ──────────────────────────────────────────────────

class VoiceAnalyzer:
    """声音寸止分析引擎

    使用方法:
        analyzer = VoiceAnalyzer()
        analyzer.on_climax(callback)  # 注册触发回调
        # 前端每100ms发送一次:
        analyzer.process_audio_data({'volume': 45.2, 'pitch': 380, 'timestamp': 1719500000.0})
    """

    def __init__(self, config: Optional[VoiceConfig] = None):
        self.cfg = config or VoiceConfig()
        self._frames: Deque[AudioFrame] = deque(maxlen=200)
        self._vocal_events: Deque[float] = deque(maxlen=100)  # 发声事件时间戳
        self._sustain_accum: float = 0.0       # 持续累积（秒）
        self._urgency_score: float = 0.0       # 急促度平滑值
        self._above_threshold_since: Optional[float] = None  # 超过阈值起始时间
        self._last_trigger_time: float = 0.0   # 上次触发时间
        self._last_data_time: float = 0.0      # 上次收到数据时间
        self._climax_callbacks: List[Callable] = []
        self._total_score: float = 0.0         # 当前综合评分（外部可读）
        self._dimension_scores: Dict[str, float] = {}  # 各维度分数

    # ─── 公共接口 ──────────────────────────────────────

    def on_climax(self, callback: Callable):
        """注册寸止触发回调，签名: callback() -> None"""
        self._climax_callbacks.append(callback)

    def process_audio_data(self, data: Dict):
        """处理前端发来的一帧音频数据

        Args:
            data: {'volume': float, 'pitch': float, 'timestamp': float}
        """
        volume = float(data.get('volume', 0))
        pitch = float(data.get('pitch', 0))
        ts = float(data.get('timestamp', time.time()))

        self._last_data_time = time.time()

        # 判断是否为有效发声
        is_vocal = volume > self.cfg.volume_floor
        frame = AudioFrame(volume=volume, pitch=pitch, timestamp=ts, is_vocal=is_vocal)
        self._frames.append(frame)

        # 记录发声事件（用于密集度计算）
        if volume > self.cfg.volume_peak_threshold:
            self._vocal_events.append(ts)

        # 数据不足时不判定
        if len(self._frames) < self.cfg.min_data_points:
            return

        # 计算各维度分数
        scores = self._compute_scores(frame)
        self._dimension_scores = scores

        # 加权综合评分
        total = (
            scores['volume'] * self.cfg.weight_volume +
            scores['pitch'] * self.cfg.weight_pitch +
            scores['density'] * self.cfg.weight_density +
            scores['urgency'] * self.cfg.weight_urgency +
            scores['sustain'] * self.cfg.weight_sustain
        )
        self._total_score = min(100.0, total * 100.0)

        # 判定是否触发
        self._check_trigger()

    @property
    def score(self) -> float:
        """当前综合评分 0-100"""
        return self._total_score

    @property
    def dimensions(self) -> Dict[str, float]:
        """各维度分数 0-1"""
        return dict(self._dimension_scores)

    def get_state(self) -> Dict:
        """获取分析器状态快照（供前端展示）"""
        return {
            'score': round(self._total_score, 1),
            'dimensions': {k: round(v, 3) for k, v in self._dimension_scores.items()},
            'sustain_seconds': round(self._sustain_accum, 2),
            'vocal_events_5s': len([t for t in self._vocal_events
                                    if time.time() - t < self.cfg.density_window]),
            'above_threshold': self._above_threshold_since is not None,
            'cooldown_remaining': max(0, self.cfg.cooldown_seconds -
                                      (time.time() - self._last_trigger_time)),
        }

    def reset(self):
        """重置所有状态"""
        self._frames.clear()
        self._vocal_events.clear()
        self._sustain_accum = 0.0
        self._urgency_score = 0.0
        self._above_threshold_since = None
        self._total_score = 0.0
        self._dimension_scores = {}

    # ─── 内部计算 ──────────────────────────────────────

    def _compute_scores(self, frame: AudioFrame) -> Dict[str, float]:
        """计算五个维度的归一化分数 (0-1)"""
        return {
            'volume': self._score_volume(frame),
            'pitch': self._score_pitch(frame),
            'density': self._score_density(),
            'urgency': self._score_urgency(),
            'sustain': self._score_sustain(frame),
        }

    def _score_volume(self, frame: AudioFrame) -> float:
        """维度1: 音量强度
        线性映射 volume_floor~volume_ceiling → 0~1
        使用最近5帧的平滑值避免单帧噪声
        """
        recent = list(self._frames)[-5:]
        avg_vol = sum(f.volume for f in recent) / len(recent)
        normalized = (avg_vol - self.cfg.volume_floor) / max(1, self.cfg.volume_ceiling - self.cfg.volume_floor)
        return max(0.0, min(1.0, normalized))

    def _score_pitch(self, frame: AudioFrame) -> float:
        """维度2: 音调高度
        低音调(呼吸) → 0, 高音调(呻吟/尖叫) → 1
        仅在有效发声时计分，静音时返回0
        """
        if not frame.is_vocal or frame.pitch < self.cfg.pitch_floor:
            return 0.0
        normalized = (frame.pitch - self.cfg.pitch_floor) / max(1, self.cfg.pitch_ceiling - self.cfg.pitch_floor)
        score = max(0.0, min(1.0, normalized))
        # 超过 pitch_weight_above 额外加成（尖叫检测）
        if frame.pitch > self.cfg.pitch_weight_above:
            score = min(1.0, score * 1.2)
        return score

    def _score_density(self) -> float:
        """维度3: 密集度
        统计最近 density_window 秒内的发声事件次数
        事件越密集（间隔越短）→ 分数越高
        """
        now = time.time()
        window_start = now - self.cfg.density_window
        # 清理过期事件
        while self._vocal_events and self._vocal_events[0] < window_start:
            self._vocal_events.popleft()
        count = len(self._vocal_events)
        if count < self.cfg.density_min_events:
            return 0.0
        normalized = (count - self.cfg.density_min_events) / max(1, self.cfg.density_max_events - self.cfg.density_min_events)
        return max(0.0, min(1.0, normalized))

    def _score_urgency(self) -> float:
        """维度4: 急促性（变化速率）
        计算最近N帧的音量上升斜率
        斜率越大 → 声音 escalate 越快 → 越紧急
        使用指数衰减平滑，避免单帧跳变误判
        """
        frames = list(self._frames)
        n = min(self.cfg.urgency_window, len(frames))
        if n < 3:
            self._urgency_score *= self.cfg.urgency_decay
            return self._urgency_score

        recent = frames[-n:]
        # 计算线性斜率 (最小二乘简化)
        dt = recent[-1].timestamp - recent[0].timestamp
        if dt < 0.01:
            dt = 0.1
        dv = recent[-1].volume - recent[0].volume
        slope = max(0, dv / dt)  # 只关注上升趋势

        # 归一化
        instant_score = min(1.0, slope / max(0.1, self.cfg.urgency_max_slope))

        # 指数平滑：上升快、衰减慢
        if instant_score > self._urgency_score:
            self._urgency_score += (instant_score - self._urgency_score) * 0.6  # 快速响应
        else:
            self._urgency_score *= self.cfg.urgency_decay  # 缓慢衰减

        return self._urgency_score

    def _score_sustain(self, frame: AudioFrame) -> float:
        """维度5: 持续性
        音量持续超过 sustain_threshold 的时间累积
        持续越久 → 越接近临界点
        低于阈值时缓慢衰减（不是立即归零）
        """
        # 估算帧间隔（约100ms）
        dt = 0.1
        if len(self._frames) >= 2:
            frames = list(self._frames)
            dt = max(0.05, frames[-1].timestamp - frames[-2].timestamp)

        if frame.volume > self.cfg.sustain_threshold:
            self._sustain_accum += dt
        else:
            self._sustain_accum *= self.cfg.sustain_decay

        normalized = self._sustain_accum / max(0.1, self.cfg.sustain_full_seconds)
        return max(0.0, min(1.0, normalized))

    # ─── 触发判定 ──────────────────────────────────────

    def _check_trigger(self):
        """检查是否满足寸止触发条件"""
        now = time.time()

        # 冷却期内不触发
        if now - self._last_trigger_time < self.cfg.cooldown_seconds:
            self._above_threshold_since = None
            return

        # 数据过期检查
        if now - self._last_data_time > self.cfg.stale_timeout:
            self._above_threshold_since = None
            return

        # 判断是否超过阈值
        if self._total_score >= self.cfg.climax_threshold:
            if self._above_threshold_since is None:
                self._above_threshold_since = now
                logger.info(f"[寸止] 评分超过阈值 {self.cfg.climax_threshold}，开始计时...")

            # 检查是否持续足够久
            hold_duration = now - self._above_threshold_since
            if hold_duration >= self.cfg.climax_hold_seconds:
                self._trigger_climax()
        else:
            # 低于阈值，重置计时（允许短暂波动）
            if self._above_threshold_since is not None:
                # 如果只是短暂跌落（<0.3s），不重置
                if self._total_score < self.cfg.climax_threshold * 0.85:
                    self._above_threshold_since = None

    def _trigger_climax(self):
        """触发寸止！停止设备。"""
        now = time.time()
        self._last_trigger_time = now
        self._above_threshold_since = None

        scores_str = ' '.join(f"{k}={v:.2f}" for k, v in self._dimension_scores.items())
        logger.warning(
            f"[寸止触发!] 综合评分={self._total_score:.1f} | {scores_str} | "
            f"持续={self._sustain_accum:.1f}s"
        )

        # 触发所有回调
        for cb in self._climax_callbacks:
            try:
                cb()
            except Exception as e:
                logger.error(f"[寸止] 回调执行失败: {e}")

        # 触发后重置部分状态
        self._sustain_accum = 0.0
        self._urgency_score = 0.0
