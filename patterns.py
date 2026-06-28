

from __future__ import annotations
import asyncio
import random
import logging
from typing import List, Dict, Tuple, Callable, Optional, TYPE_CHECKING
from dataclasses import dataclass
from enum import Enum

if TYPE_CHECKING:
    from core.device import YCYDevice

logger = logging.getLogger("ycy.patterns")

class PatternType(str, Enum):
    WAVE      = "wave"
    PULSE     = "pulse"
    ESCALATE  = "escalate"
    RANDOM    = "random"
    COMBO     = "combo"
    SCRIPT    = "script"

@dataclass
class PatternConfig:
    
    pattern: PatternType = PatternType.RANDOM
    duration: float = 60.0
    interval: Tuple[float, float] = (3.0, 10.0)
    a_range: Tuple[int, int] = (0, 40)
    b_range: Tuple[int, int] = (0, 20)
    c_range: Tuple[int, int] = (0, 20)
    b_exhale_ratio: float = 0.6
    script: List[dict] = None

    def to_dict(self) -> dict:
        return {
            'pattern': self.pattern.value,
            'duration': self.duration,
            'interval': list(self.interval),
            'a_range': list(self.a_range),
            'b_range': list(self.b_range),
            'c_range': list(self.c_range),
        }

class PatternEngine:
    

    def __init__(self, device: YCYDevice):
        self.device = device
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._step_count = 0

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def step_count(self) -> int:
        return self._step_count

    async def start(self, config: PatternConfig):
        
        if self._running:
            await self.stop()

        self._running = True
        self._step_count = 0
        self._task = asyncio.create_task(self._run(config))
        logger.info(f"模式启动: {config.pattern.value}")

    async def stop(self):
        
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self.device.emergency_stop()
        logger.info("模式已停止")

    async def _run(self, config: PatternConfig):
        
        start_time = asyncio.get_event_loop().time()
        generator = self._get_generator(config)

        try:
            while self._running:
                elapsed = asyncio.get_event_loop().time() - start_time
                if config.duration > 0 and elapsed >= config.duration:
                    logger.info(f"模式运行时长已达 {config.duration}s，自动停止")
                    break

                speeds = next(generator)
                self._step_count += 1

                a, b, c = speeds
                if b > 0:
                    ratio = 1.0 - (b / 20.0) * 0.8
                    a = min(a, max(0, int(40 * ratio)))
                try: await self.device.set_speed(a=a, b=b, c=c)
                except: pass
                logger.info(f"[步{self._step_count}] A={a} B={b} C={c}")

                delay = random.uniform(*config.interval)
                await asyncio.sleep(delay)

                if b > 0 and config.b_exhale_ratio > 0:
                    exhale_time = delay * config.b_exhale_ratio
                    exhale_time = max(0.5, min(3.0, exhale_time))
                    try: await self.device.set_speed(b=0)
                    except: pass
                    await asyncio.sleep(exhale_time)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"模式执行出错: {e}", exc_info=True)
        finally:
            self._running = False

    def _get_generator(self, config: PatternConfig):
        
        generators = {
            PatternType.WAVE: self._gen_wave,
            PatternType.PULSE: self._gen_pulse,
            PatternType.ESCALATE: self._gen_escalate,
            PatternType.RANDOM: self._gen_random,
            PatternType.COMBO: self._gen_combo,
            PatternType.SCRIPT: self._gen_script,
        }
        gen_func = generators.get(config.pattern, self._gen_random)
        return gen_func(config)

    def _gen_random(self, config: PatternConfig):
        
        while True:
            a = random.randint(*config.a_range)
            b = random.randint(*config.b_range)
            c = random.randint(*config.c_range)
            yield (a, b, c)

    def _gen_wave(self, config: PatternConfig):
        
        step = 0
        while True:
            phase = step % 3
            t = (step // 3) % 10
            ratio = abs(t - 5) / 5

            a_lo, a_hi = config.a_range
            b_lo, b_hi = config.b_range
            c_lo, c_hi = config.c_range

            a = int(a_lo + (a_hi - a_lo) * ratio) if phase == 0 else a_lo
            b = int(b_lo + (b_hi - b_lo) * ratio) if phase == 1 else b_lo
            c = int(c_lo + (c_hi - c_lo) * ratio) if phase == 2 else c_lo

            yield (a, b, c)
            step += 1

    def _gen_pulse(self, config: PatternConfig):
        
        while True:
            a = random.randint(max(config.a_range[0], 15), config.a_range[1])
            b = random.randint(max(config.b_range[0], 10), config.b_range[1])
            c = random.randint(max(config.c_range[0], 10), config.c_range[1])
            yield (a, b, c)
            yield (0, 0, 0)

    def _gen_escalate(self, config: PatternConfig):
        
        steps = 10
        direction = 1
        level = 0

        while True:
            ratio = level / steps
            a_lo, a_hi = config.a_range
            b_lo, b_hi = config.b_range
            c_lo, c_hi = config.c_range

            a = int(a_lo + (a_hi - a_lo) * ratio)
            b = int(b_lo + (b_hi - b_lo) * ratio)
            c = int(c_lo + (c_hi - c_lo) * ratio)

            yield (a, b, c)

            level += direction
            if level >= steps:
                direction = -1
            elif level <= 0:
                direction = 1

    def _gen_combo(self, config: PatternConfig):
        
        sub_gens = [
            self._gen_random(config),
            self._gen_wave(config),
            self._gen_pulse(config),
        ]
        current = random.choice(sub_gens)
        switch_at = random.randint(5, 15)
        count = 0

        while True:
            yield next(current)
            count += 1
            if count >= switch_at:
                current = random.choice(sub_gens)
                switch_at = random.randint(5, 15)
                count = 0

    def _gen_script(self, config: PatternConfig):
        
        if not config.script:
            yield from self._gen_random(config)
            return

        idx = 0
        while True:
            step = config.script[idx % len(config.script)]
            a = step.get('a', 0)
            b = step.get('b', 0)
            c = step.get('c', 0)
            yield (a, b, c)
            idx += 1
