#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qq-bridge TTS helper.

协议：stdin 读一个 JSON，stdout 写一个 JSON（UTF-8），不依赖命令行传中文。
请求：{"text": "...", "voice": "zh-CN-XiaoyiNeural", "rate": "+0%",
       "pitch": "+0Hz", "volume": "+0%", "output": "D:/.../x.mp3"}
响应：{"ok": true, "file": "...", "bytes": 123, "ms": 1200, "voice": "..."}
      {"ok": false, "error": "..."}

单独跑 `--list-voices` 可列出全部音色（含 zh-CN 标记）。
"""

import asyncio
import json
import os
import sys
import time

MAX_TEXT = 500


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


async def synth(text, voice, rate, pitch, volume, out_path):
    import edge_tts  # 延迟导入：--list-voices 之外才需要

    kwargs = {"rate": rate, "pitch": pitch, "volume": volume}
    # edge-tts 7.x：proxy 为空时走环境变量
    com = edge_tts.Communicate(text, voice, **kwargs)
    await com.save(out_path)


async def list_voices():
    import edge_tts

    voices = await edge_tts.list_voices()
    out = []
    for v in voices:
        sn = v.get("ShortName") or ""
        out.append(
            {
                "name": sn,
                "gender": v.get("Gender"),
                "locale": v.get("Locale"),
                "zh": sn.startswith("zh-"),
            }
        )
    return out


def main():
    if "--list-voices" in sys.argv:
        try:
            emit({"ok": True, "voices": asyncio.run(list_voices())})
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0

    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        req = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"请求解析失败：{exc}"})
        return 0

    text = str(req.get("text") or "").strip()
    out_path = str(req.get("output") or "").strip()
    if not text:
        emit({"ok": False, "error": "text 为空"})
        return 0
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    if not out_path:
        emit({"ok": False, "error": "output 为空"})
        return 0

    voice = str(req.get("voice") or "zh-CN-XiaoyiNeural")
    rate = str(req.get("rate") or "+0%")
    pitch = str(req.get("pitch") or "+0Hz")
    volume = str(req.get("volume") or "+0%")

    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"创建目录失败：{exc}"})
        return 0

    started = time.time()
    try:
        asyncio.run(synth(text, voice, rate, pitch, volume, out_path))
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0

    size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    if size <= 0:
        emit({"ok": False, "error": "合成结果为空文件"})
        return 0

    emit(
        {
            "ok": True,
            "file": out_path,
            "bytes": size,
            "ms": int((time.time() - started) * 1000),
            "voice": voice,
            "chars": len(text),
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
