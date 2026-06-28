"""
AI 人格控制器
==============

AI大模型驱动的人格化控制引擎。
每个 tick 向大模型发送当前状态，由 AI 决定下一步参数。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING

from dotenv import load_dotenv
from openai import OpenAI

if TYPE_CHECKING:
    from device import YCYDevice

logger = logging.getLogger("ycy.ai")

# ─── 加载 .env ─────────────────────────────────────────────
load_dotenv(Path(__file__).parent / ".env")

PERSONALITIES_DIR = Path(__file__).parent.parent / "personalities"

# ─── 人格数据结构 ──────────────────────────────────────────


@dataclass
class PersonalityProfile:
    """从 JSON 文件加载的人格配置"""

    id: str
    name: str
    emoji: str
    description: str
    traits: Dict[str, Any]
    rules: List[str]
    pacing: Dict[str, Any]
    channel_weights: Dict[str, float]
    behavioral_patterns: Dict[str, Any] = field(default_factory=dict)
    psychology: Dict[str, Any] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> PersonalityProfile:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(
            id=data["id"],
            name=data["name"],
            emoji=data.get("emoji", "🤖"),
            description=data.get("description", ""),
            traits=data.get("traits", {}),
            rules=data.get("rules", []),
            pacing=data.get("pacing", {}),
            channel_weights=data.get("channel_weights", {}),
            behavioral_patterns=data.get("behavioral_patterns", {}),
            psychology=data.get("psychology", {}),
            raw=data,
        )

    def build_system_prompt(self) -> str:
        """构建完整的中文系统提示词"""
        traits_text = "\n".join(f"  - {k}: {v}" for k, v in self.traits.items())
        rules_text = "\n".join(f"  {i+1}. {r}" for i, r in enumerate(self.rules))
        weights_text = ", ".join(f"{k}={v}" for k, v in self.channel_weights.items())

        prompt = f"""你是一个BLE设备控制AI，你的人格是「{self.emoji} {self.name}」。

## 你的描述
{self.description}

## 你的性格特质
{traits_text}

## 通道偏好权重
{weights_text}

## 行为规则（必须严格遵守）
{rules_text}
"""

        # 添加 behavioral_patterns
        if self.behavioral_patterns:
            bp_text = ""
            for name, bp in self.behavioral_patterns.items():
                desc = bp.get("description", "")
                bp_text += f"  - {name}: {desc}\n"
                if "trigger" in bp:
                    bp_text += f"    触发条件: {bp['trigger']}\n"
                if "probability" in bp:
                    bp_text += f"    概率: {bp['probability']}\n"
            prompt += f"\n## 行为模式\n{bp_text}"

        # 添加 pacing
        if self.pacing:
            pacing_text = "\n".join(f"  - {k}: {v}" for k, v in self.pacing.items())
            prompt += f"\n## 节奏配置\n{pacing_text}"

        # 添加 psychology
        if self.psychology:
            psych_text = "\n".join(
                f"  - {k}: {v}" for k, v in self.psychology.items()
            )
            prompt += f"\n## 心理学设定\n{psych_text}"

        prompt += f"""

## 输出要求
你必须严格以JSON格式回复，不要有任何其他文字：
{{"a": <0-40的整数>, "b": <0-20的整数>, "c": <0-20的整数>, "narration": "<中文描述，1-2句话，完全以你的人格角色说话，描述你正在做什么>", "behavior": "<你当前使用的行为模式名称>", "mood": "<一个emoji表达你当前的情绪>"}}

字段说明：
- a: 旋转伸缩通道 0-40 (0=停, 1-20正转, 21-40反转)
- b: 吮吸通道 0-20 (0=放气/停止, 1=不动, 2-20=吸气)
- c: 震动通道 0-20 (0=停止)

重要：你必须在以下四种状态之间切换，不能一直三个通道都开：
1. 全停(A=0,B=0,C=0) — 休息/等待
2. 单通道 — 只开一个，其他为0
3. 双通道 — 开两个，一个为0
4. 三通道 — 全开

规则：
- 每5步之内必须出现至少一次全停
- 单通道和双通道的频率要和全开差不多
- 不要连续3步开三个通道
- 你可以用单通道挑逗，然后突然全开
- b: 吮吸通道 0-20 (0=放气, 1=不动, 2-20=吸气)
- c: 震动通道 0-20
- narration: 以你的人格身份说的1-2句话中文独白，要完全沉浸在角色中
- behavior: 你选择的行为模式名称
- mood: 一个emoji

重要：你的narration必须完全以第一人称、以你的角色说话，要有人格特色。不要解释你的行为，直接用角色的语气描述。
"""
        return prompt


def list_personalities() -> List[Dict[str, str]]:
    """列出可用的人格文件"""
    result = []
    for f in sorted(PERSONALITIES_DIR.glob("*.json")):
        try:
            p = PersonalityProfile.load(f)
            result.append({"id": p.id, "name": p.name, "emoji": p.emoji})
        except Exception as e:
            logger.warning(f"加载人格文件失败 {f}: {e}")
    return result


# ─── AI 控制引擎 ──────────────────────────────────────────


class AIController:
    """AI 人格化控制引擎"""

    def __init__(self, device: YCYDevice):
        self.device = device
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._personality: Optional[PersonalityProfile] = None
        self._client: Optional[OpenAI] = None
        self._max_duration: float = 1800  # 30分钟默认
        self._step_count: int = 0
        self._history: List[Dict] = []  # 最近20步
        self._intensity_trend: List[float] = []
        self._edge_count: int = 0
        self._invalid_count: int = 0  # 连续无效响应计数
        self._start_time: float = 0
        self._tick_callback: Optional[Callable] = None
        self._narration_callback: Optional[Callable] = None

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def step_count(self) -> int:
        return self._step_count

    @property
    def edge_count(self) -> int:
        return self._edge_count

    @property
    def intensity(self) -> float:
        """当前强度百分比 0-100"""
        if not self._intensity_trend:
            return 0.0
        return self._intensity_trend[-1]

    @property
    def elapsed(self) -> float:
        if not self._start_time:
            return 0
        return time.time() - self._start_time

    def on_tick(self, callback: Callable):
        """注册每次决策回调"""
        self._tick_callback = callback

    def on_narration(self, callback: Callable):
        """注册旁白回调"""
        self._narration_callback = callback

    def _init_client(self):
        """初始化 AI 客户端"""
        api_key = os.environ.get("AI_API_KEY", "")
        if not api_key:
            raise ValueError("AI_API_KEY 未配置")
        self._client = OpenAI(
            api_key=api_key,
            base_url=os.environ.get("AI_BASE_URL", ""),
        )

    async def start(
        self,
        personality_id: str,
        max_duration: float = 1800,
    ):
        """启动 AI 控制"""
        if self._running:
            await self.stop()

        # 加载人格
        path = PERSONALITIES_DIR / f"{personality_id}.json"
        if not path.exists():
            raise FileNotFoundError(f"人格文件不存在: {path}")
        self._personality = PersonalityProfile.load(path)

        # 初始化客户端
        self._init_client()

        # 重置状态
        self._max_duration = max_duration
        self._step_count = 0
        self._history = []
        self._intensity_trend = []
        self._edge_count = 0
        self._invalid_count = 0
        self._start_time = time.time()
        self._running = True

        # 启动执行任务
        self._task = asyncio.create_task(self._run_loop())
        logger.info(
            f"AI控制启动: {self._personality.emoji} {self._personality.name}, "
            f"最大时长 {max_duration}s"
        )

    async def stop(self):
        """停止 AI 控制"""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # 停止设备
        try:
            try: await self.device.emergency_stop()
            except: pass
        except Exception:
            pass
        logger.info("AI控制已停止")

    async def _run_loop(self):
        """主循环：每 tick 调用一次 AI"""
        system_prompt = self._personality.build_system_prompt()
        messages = [{"role": "system", "content": system_prompt}]

        try:
            while self._running:
                # 检查超时
                elapsed = time.time() - self._start_time
                if self._max_duration > 0 and elapsed >= self._max_duration:
                    logger.info(
                        f"AI控制达到最大时长 {self._max_duration}s，自动停止"
                    )
                    break

                # 构建当前状态
                state_msg = self._build_state_message()
                messages.append({"role": "user", "content": state_msg})

                # 保持消息历史合理长度（系统+最近10轮对话）
                if len(messages) > 21:  # 1 system + 10 * 2 (user+assistant)
                    messages = [messages[0]] + messages[-20:]

                # 调用 AI
                try:
                    loop = asyncio.get_event_loop()
                    response = await loop.run_in_executor(
                        None, self._call_ai, messages
                    )
                except Exception as e:
                    logger.error(f"AI 调用失败: {e}")
                    self._invalid_count += 1
                    if self._invalid_count >= 3:
                        logger.error("连续3次AI调用失败，紧急停止")
                        break
                    messages.pop()  # 移除失败的user消息
                    await asyncio.sleep(5)
                    continue

                # 解析响应
                parsed = self._parse_response(response)
                if parsed is None:
                    self._invalid_count += 1
                    logger.warning(
                        f"AI返回无效数据 ({self._invalid_count}/3)"
                    )
                    if self._invalid_count >= 3:
                        logger.error("连续3次无效响应，紧急停止")
                        break
                    # 添加 assistant 消息让 AI 知道自己返回了错误
                    messages.append(
                        {
                            "role": "assistant",
                            "content": response,
                        }
                    )
                    messages.append(
                        {
                            "role": "user",
                            "content": "你的回复格式不正确，请严格以JSON格式回复，不要包含任何其他文字。请重试。",
                        }
                    )
                    await asyncio.sleep(2)
                    continue

                # 有效响应，重置无效计数
                self._invalid_count = 0

                # 添加 assistant 回复到历史
                messages.append({"role": "assistant", "content": response})

                # 执行设备控制
                a, b, c = parsed["a"], parsed["b"], parsed["c"]
                try: await self.device.set_speed(a=a, b=b, c=c)
                except: pass

                # 更新统计
                self._step_count += 1
                intensity = self._calc_intensity(a, b, c)
                self._intensity_trend.append(intensity)

                # 检测 edge（高强度后突然归零）
                if len(self._intensity_trend) >= 2:
                    prev = self._intensity_trend[-2]
                    if prev > 60 and intensity < 10:
                        self._edge_count += 1
                        logger.info(f"Edge 检测! 总计: {self._edge_count}")

                # 记录历史
                step_record = {
                    "step": self._step_count,
                    "a": a,
                    "b": b,
                    "c": c,
                    "intensity": intensity,
                    "narration": parsed["narration"],
                    "behavior": parsed["behavior"],
                    "mood": parsed["mood"],
                    "time": time.time(),
                }
                self._history.append(step_record)
                if len(self._history) > 20:
                    self._history = self._history[-20:]

                logger.info(
                    f"[AI步{self._step_count}] A={a} B={b} C={c} "
                    f"| {parsed['mood']} {parsed['behavior']} "
                    f"| {parsed['narration'][:30]}"
                )

                # 触发回调
                if self._tick_callback:
                    self._tick_callback(step_record)
                if self._narration_callback:
                    self._narration_callback(parsed["narration"])

                # 计算等待时间
                interval = self._calc_interval(parsed)
                await asyncio.sleep(interval)

                # B通道自动放气
                if b > 0:
                    exhale_time = max(0.5, min(3.0, interval * 0.6))
                    try: await self.device.set_speed(b=0)
                    except: pass
                    await asyncio.sleep(exhale_time)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"AI循环出错: {e}", exc_info=True)
        finally:
            self._running = False
            try:
                await self.device.emergency_stop()
            except Exception:
                pass

    def _call_ai(self, messages: List[Dict]) -> str:
        """同步调用 AI 模型"""
        resp = self._client.chat.completions.create(
            model=os.environ.get("AI_MODEL", "default"),
            messages=messages,
            temperature=0.8,
            max_tokens=256,
        )
        return resp.choices[0].message.content.strip()

    def _build_state_message(self) -> str:
        """构建当前状态的用户消息"""
        speeds = self.device.state.speeds
        recent = self._history[-5:] if self._history else []
        recent_text = ""
        if recent:
            lines = []
            for r in recent:
                lines.append(
                    f"  步{r['step']}: A={r['a']} B={r['b']} C={r['c']} "
                    f"| {r['mood']} {r['behavior']}"
                )
            recent_text = "\n".join(lines)

        elapsed = time.time() - self._start_time
        remaining = max(0, self._max_duration - elapsed) if self._max_duration > 0 else "无限"

        msg = f"""当前状态：
- 已执行步数: {self._step_count}
- 已运行时间: {elapsed:.0f}秒
- 剩余时间: {remaining if isinstance(remaining, str) else f'{remaining:.0f}秒'}
- 当前设备速度: A={speeds['A']} B={speeds['B']} C={speeds['C']}
- 当前强度: {self.intensity:.0f}%
- Edge次数: {self._edge_count}
- 最近强度趋势: {', '.join(f'{t:.0f}%' for t in self._intensity_trend[-5:]) or '无'}
"""

        if recent_text:
            msg += f"\n最近操作历史:\n{recent_text}"

        msg += "\n\n请决定下一步操作。严格以JSON格式回复。"
        return msg

    def _parse_response(self, text: str) -> Optional[Dict]:
        """解析 AI 响应，返回有效数据或 None"""
        # 尝试提取 JSON
        try:
            # 尝试直接解析
            data = json.loads(text)
        except json.JSONDecodeError:
            # 尝试从文本中提取 JSON 块
            import re
            match = re.search(r'\{[^{}]*"a"[^{}]*\}', text, re.DOTALL)
            if match:
                try:
                    data = json.loads(match.group())
                except json.JSONDecodeError:
                    return None
            else:
                return None

        # 验证必需字段
        required = ["a", "b", "c", "narration", "behavior", "mood"]
        if not all(k in data for k in required):
            return None

        # 验证范围
        try:
            a = int(data["a"])
            b = int(data["b"])
            c = int(data["c"])
        except (ValueError, TypeError):
            return None

        if not (0 <= a <= 40):
            a = max(0, min(40, a))
        if not (0 <= b <= 20):
            b = max(0, min(20, b))
        if not (0 <= c <= 20):
            c = max(0, min(20, c))

        return {
            "a": a,
            "b": b,
            "c": c,
            "narration": str(data["narration"])[:200],
            "behavior": str(data["behavior"])[:50],
            "mood": str(data["mood"])[:10],
        }

    def _calc_intensity(self, a: int, b: int, c: int) -> float:
        """计算当前强度百分比 0-100"""
        # 归一化各通道到 0-1
        a_norm = a / 40.0
        b_norm = b / 20.0
        c_norm = c / 20.0
        # 加权平均
        weights = self._personality.channel_weights
        intensity = (
            a_norm * weights.get("A", 0.33)
            + b_norm * weights.get("B", 0.33)
            + c_norm * weights.get("C", 0.33)
        )
        return min(100.0, intensity * 100)

    def _calc_interval(self, parsed: Dict) -> float:
        """根据当前状态和人格计算等待间隔"""
        import random

        pacing = self._personality.pacing
        intensity = self._calc_intensity(parsed["a"], parsed["b"], parsed["c"])

        if intensity > 70:
            interval_range = pacing.get("excitement_interval", [2.0, 5.0])
        else:
            interval_range = pacing.get("base_interval", [3.0, 6.0])

        return random.uniform(*interval_range)

    def get_state(self) -> Dict:
        """获取当前 AI 控制状态快照"""
        return {
            "running": self._running,
            "personality": (
                {
                    "id": self._personality.id,
                    "name": self._personality.name,
                    "emoji": self._personality.emoji,
                }
                if self._personality
                else None
            ),
            "step_count": self._step_count,
            "edge_count": self._edge_count,
            "intensity": round(self.intensity, 1),
            "elapsed": round(self.elapsed, 1),
            "max_duration": self._max_duration,
            "last_narration": (
                self._history[-1]["narration"] if self._history else ""
            ),
            "last_behavior": (
                self._history[-1]["behavior"] if self._history else ""
            ),
            "last_mood": self._history[-1]["mood"] if self._history else "",
            "recent_speeds": [
                {"a": h["a"], "b": h["b"], "c": h["c"]}
                for h in self._history[-5:]
            ],
        }
