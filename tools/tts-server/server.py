"""本地中文语音合成服务，说 OpenAI 那套 `/v1/audio/speech`。

存在的理由只有一个：**证明那个接口是真的通用的**。桌面壳里没有一行代码知道
Kokoro 的存在 —— 它只会往你填的地址发一个标准请求。这个脚本接住那个请求，用一个
本地模型合成，回一段音频。换成任何别的模型，只要照样接住这个请求就行。

模型是 Kokoro v1.1-zh（Apache-2.0，82M 参数）。选它是因为三条同时成立：许可干净、
小到 CPU 也跑得动、而且带 55 个中文女声可挑 —— 前两条决定了它能不能用，第三条决定
了能不能挑出一个少女音。

**这不是初音未来的声音，也永远不会是。** Miku 是歌声合成器，没有官方中文语音合成；
社区那些克隆音色拿的是 Vocaloid 音源，而 Crypton 的角色授权不含声音。这里合成的是
一个和她无关的、普通的中文女声。

用法::

    python server.py                 # 默认 127.0.0.1:9880，音色 zf_001
    python server.py --voice zf_038 --port 9881
    python server.py --list          # 列出所有中文女声，不起服务

然后在 设置 → 通用设置 → 桌面宠物 → 语音提醒 里：来源选「外接服务」，
地址填 http://127.0.0.1:9880/v1/audio/speech，音色名填 zf_001，密钥留空。
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# Kokoro 的采样率是模型定死的，不是可调项。
SAMPLE_RATE = 24000

# 一次合成的字数上限，和桌面壳那边一致。再长的提醒没人听得下去。
MAX_CHARS = 200

# 只认这两个语言标记：'z' 中文、'a' 英文。宠物说中文。
LANG_CODE = "z"


def to_wav(samples: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    """把浮点采样打成 WAV 字节。

    回 WAV 而不是 mp3：不需要额外的编码器依赖，而一句提醒的 WAV 只有几十 KB，
    走本机回环完全不值得为了压缩再拖一个 ffmpeg 进来。

    :param samples: −1..1 的单声道浮点采样
    :param rate: 采样率
    :returns: 完整的 WAV 文件字节
    """
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())
    return buf.getvalue()


class Synth:
    """Kokoro 的薄封装，带一把锁。

    模型不是线程安全的，而 HTTP 服务是多线程的：两条提醒同时到达会让两次前向传播
    交错，输出是噪音。加锁排队 —— 合成一句几百毫秒，排队远好过出错。
    """

    def __init__(self, repo: str, default_voice: str, threads: int = 0) -> None:
        import torch
        from kokoro import KPipeline  # 延迟导入：--list 不需要加载 torch

        # 超线程反而更慢：实测 20 线程 4.15x 实时、12 线程 5.08x。默认交给 torch。
        if threads > 0:
            torch.set_num_threads(threads)

        self._lock = threading.Lock()
        self._default = default_voice
        self._pipeline = KPipeline(lang_code=LANG_CODE, repo_id=repo)

    def warm(self) -> float:
        """先空跑一句，把首次调用的开销挪到启动时。

        冷调用要 9 秒，热调用不到 1 秒 —— 差的是 jieba 建词典、权重换入、以及第一次
        前向传播的各种惰性初始化。不预热的话，你收到的**第一条**提醒会晚十秒，而那
        恰恰是最会让人以为功能坏了的一次。

        :returns: 预热耗时（秒）
        """
        import time

        started = time.time()
        try:
            self.speak("预热", self._default, 1.0)
        except Exception:  # 预热失败不该挡住启动；真正的请求会再报一次错
            pass
        return time.time() - started

    def speak(self, text: str, voice: str, speed: float) -> np.ndarray:
        """合成一句。

        :param text: 要念的中文
        :param voice: 音色名，如 ``zf_001``
        :param speed: 语速倍率
        :returns: 拼好的单声道浮点采样
        :raises ValueError: 模型什么也没生成（通常是文本里没有可读的字）
        """
        chunks: list[np.ndarray] = []
        with self._lock:
            for _graphemes, _phonemes, audio in self._pipeline(
                text, voice=voice or self._default, speed=speed
            ):
                chunks.append(np.asarray(audio, dtype=np.float32))
        if not chunks:
            raise ValueError("模型没有生成任何音频")
        return np.concatenate(chunks)


def make_handler(synth: Synth):
    """建一个绑定到给定合成器的请求处理类。

    :param synth: 已加载的合成器
    :returns: BaseHTTPRequestHandler 的子类
    """

    class Handler(BaseHTTPRequestHandler):
        # 默认的 log_message 会把每条请求打到 stderr，跑起来就是满屏。
        def log_message(self, *_args) -> None:  # noqa: D102
            pass

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            # 一个能用浏览器打开的活性检查，省得你怀疑是不是没起来。
            if self.path.rstrip("/") in ("", "/health"):
                self._json(200, {"ok": True, "voice": synth._default, "rate": SAMPLE_RATE})
                return
            self._json(404, {"error": "只有 POST /v1/audio/speech"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/v1/audio/speech":
                self._json(404, {"error": "只有 POST /v1/audio/speech"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                self._json(400, {"error": "请求不是 JSON"})
                return

            text = str(payload.get("input") or "").strip()[:MAX_CHARS]
            if not text:
                self._json(400, {"error": "input 是空的"})
                return
            voice = str(payload.get("voice") or "").strip()
            try:
                speed = float(payload.get("speed") or 1.0)
            except (TypeError, ValueError):
                speed = 1.0
            speed = min(2.0, max(0.5, speed))

            try:
                audio = synth.speak(text, voice, speed)
            except Exception as err:  # 合成失败要说得出原因，客户端会把它显示出来
                self._json(500, {"error": f"{type(err).__name__}: {err}"})
                return

            wav = to_wav(audio)
            # 回音频字节本身，不是 JSON —— 桌面壳按 arrayBuffer 读。
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)

    return Handler


def list_voices(repo: str) -> None:
    """把仓库里的中文女声列出来。

    :param repo: HuggingFace 仓库名
    """
    from huggingface_hub import list_repo_files

    names = sorted(
        f.split("/")[-1].removesuffix(".pt")
        for f in list_repo_files(repo)
        if "/zf_" in f
    )
    print(f"{repo} 的中文女声（{len(names)} 个）：")
    for i in range(0, len(names), 8):
        print("  " + "  ".join(names[i : i + 8]))


def main() -> int:
    """入口。

    :returns: 进程退出码
    """
    parser = argparse.ArgumentParser(description="本地中文 TTS，说 OpenAI 的 /v1/audio/speech")
    parser.add_argument("--repo", default="hexgrad/Kokoro-82M-v1.1-zh")
    parser.add_argument("--voice", default="zf_001", help="默认音色，请求里带 voice 就用请求的")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--list", action="store_true", help="列出中文女声后退出")
    parser.add_argument("--threads", type=int, default=0, help="torch 线程数，0 用默认")
    args = parser.parse_args()

    if args.list:
        list_voices(args.repo)
        return 0

    print(f"正在加载 {args.repo} …（首次会下载约 350MB）", flush=True)
    synth = Synth(args.repo, args.voice, args.threads)
    print(f"预热 {synth.warm():.1f}s", flush=True)
    # 只绑本机：这个服务没有任何鉴权，不该出现在局域网上。
    server = ThreadingHTTPServer((args.host, args.port), make_handler(synth))
    url = f"http://{args.host}:{args.port}/v1/audio/speech"
    print(f"就绪 → {url}   默认音色 {args.voice}", flush=True)
    print("在 设置 → 通用设置 → 桌面宠物 → 语音提醒 里把地址填成上面这个，密钥留空。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n停了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
