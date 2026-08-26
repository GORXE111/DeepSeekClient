# 本地中文语音服务

一个跑在本机的语音合成服务，说 OpenAI 那套 `/v1/audio/speech`。

**存在的理由是证明接口是通用的**：桌面壳里没有一行代码知道这个脚本或 Kokoro 的存在，
它只会往配置里填的地址发一个标准请求。换成任何别的模型，只要照样接住这个请求、回一
段音频，就同样能用。

可选，不参与构建，也不进安装包。

> **语音默认是关的，设置面板里也没有那一栏。** 试下来音色不够好听，所以它是留给后
> 来人的扩展点而不是产品功能。要打开得手工改 `~/.dsh/settings.yaml`，见
> [根 README](../../README.md#语音提醒接口保留默认不启用)。

## 用什么模型

[Kokoro v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)，**Apache-2.0**，
82M 参数。选它是因为三条同时成立：

- 许可干净，能放心用；
- 小到 CPU 也跑得动（这台机器上一句话约 0.5 秒），不必配 CUDA；
- 带 55 个中文女声可挑 —— 前两条决定能不能用，这条决定能不能挑出一个少女音。

**这不是初音未来的声音。** Miku 是歌声合成器，没有官方中文语音合成产品；社区那些
克隆音色拿的是 Vocaloid 音源，而 Crypton 的角色授权（CC BY-NC）授的是形象、名字、
外观，**不含声音**。这里合成的是一个与她无关的普通中文女声。

## 装

```sh
python -m venv .venv-tts                                    # 在仓库根目录
.venv-tts/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv-tts/Scripts/python -m pip install kokoro "misaki[zh]" soundfile
```

`torch` 单独从 CPU 源装：默认源在有些平台上会拉 2.5GB 的 CUDA 包，而这个模型
CPU 足够。整个环境约 700MB，模型权重另约 350MB，走 HuggingFace 的缓存目录
（`~/.cache/huggingface`），首次运行时自动下载。

环境目录 `.venv-tts/` 已在 `.gitignore` 里。

## 跑

```sh
.venv-tts/Scripts/python tools/tts-server/server.py            # 127.0.0.1:9880
.venv-tts/Scripts/python tools/tts-server/server.py --list     # 列出全部中文女声
.venv-tts/Scripts/python tools/tts-server/server.py --voice zf_038 --port 9881
```

起来之后浏览器打开 <http://127.0.0.1:9880/health> 能看到一行 JSON，说明活着。

## 接进客户端

改 `~/.dsh/settings.yaml`，然后重启客户端：

```yaml
pet:
  voice: true
  voiceProvider: http
  voiceUrl: http://127.0.0.1:9880/v1/audio/speech
  voiceKey: ""
  voiceId: zf_001          # 或 --list 里挑的任意一个
  voiceFormat: wav         # 这个服务一律回 WAV
```

明文 `http` 能填是因为客户端只对 `localhost` / `127.0.0.1` 放行 —— 本地模型服务
基本都是裸 http，但往公网明文发密钥不行。

不出声的话，客户端的控制台会写明原因（`ECONNREFUSED` = 服务没开，401 = 密钥不对，
诸如此类）。

## 挑音色

55 个女声里音质和年龄感差别不小。`--list` 列出全部，改 `--voice`（或直接改客户端
里的音色名，请求里带的优先）逐个试。

选好之后这个服务要一直开着 —— 关掉之后客户端会退回系统音色，不会静音。

音高可以量，不必只靠耳朵。合成同一句话再算中位基频：成年女性说话通常 165–255 Hz，
Windows 的 Huihui 是 176 Hz。实测 `zf_038` 338 Hz、`zf_017` 333 Hz、`zf_070` 300 Hz
落在少女音区，`zf_046` 197 Hz 则偏成熟。

## 换成别的模型

改 `server.py` 里的 `Synth` 类就行，HTTP 那一半不用动。要保持的只有三件事：

- `POST /v1/audio/speech`，请求体 `{model, input, voice, response_format, speed}`
- 回**音频字节本身**，不是 JSON
- 失败回 4xx/5xx 并在 JSON 里带 `error`，客户端会把它显示出来
