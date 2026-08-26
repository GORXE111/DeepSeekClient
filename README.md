# DeepSeek Client

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端。前后端在一个包里，装完就能用 —— 你只需要配一个 API key，或者指向自己机器上的本地模型。

没有浏览器标签页，没有要记的端口号，**运行时不监听任何网络端口**。

## 仓库布局

前端、后端与桌面壳全在这一个仓库里，界面上跑的就是这里的源码。

```
harness/     DeepSeek Harness 源码（前端 + 后端），含本仓库的改动
desktop/     Electron 壳：窗口、托盘、通知、悬浮宠物
tools/       构建脚本
runtime/     产物：harness 运行时闭包（不入库）
dist/        产物：安装包（不入库）
```

`harness/` 取自官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
的 `dsh-v0.1.1-rc.2`（MIT），在其上带三处本仓库的改动：外观设置、中文输入法预编辑
修复、以及 Windows 上的 lefthook 安装修复。

## 桌面宠物

桌面角落常驻一个像素小人（默认关闭，视图菜单里开）：智能体干完一轮它会来报一声、
点开可以直接问小问题、按住能拖着走。称呼你的昵称在 设置 → 通用设置 → 桌面宠物。

形象为初音未来，版权属 Crypton Future Media, INC.，按 **CC BY-NC**（署名 — 非商业）
使用。**本项目转为商业分发前必须另行取得 Crypton 许可，或换掉这套形象。**
详见 [desktop/renderer/assets/README.md](desktop/renderer/assets/README.md)。

### 语音提醒

默认关着，在 设置 → 通用设置 → 桌面宠物 → 语音提醒 打开。两种来源：

**系统音色** —— 离线免费，用机器上装了的中文音色。Windows 自带的那几个
（Huihui / Kangkang / Yaoyao）都是十年前的 SAPI 音色，听着像播报。

没有音调滑块是实测的结论：SAPI 的音调标记会改变输出字节，但把 −10 / 0 / +10 三档
各合成一遍再测中位基频，只在 176 / 184 / 181 Hz 之间抖，听感几乎不动。一个拧了没
反应的旋钮比没有更糟。语速是真有用。

**外接服务** —— 想要好听的声音走这条。本项目**不内置也不绑定任何音色**，只留接口。

接口就是 OpenAI 的 `/v1/audio/speech`，被抄得很广（Azure 网关、SiliconFlow、
Fish Audio、本地 GPT-SoVITS 的 HTTP 封装都认）。壳发出去的是：

```
POST <你填的地址>
Authorization: Bearer <你填的密钥>     # 密钥留空则不发这个头
Content-Type: application/json

{ "model": "<模型>", "input": "<要念的话>", "voice": "<音色名>",
  "response_format": "mp3|wav|opus|aac|flac", "speed": <语速> }
```

期望回来的是**音频字节本身**（不是 JSON）。只要一个服务能接住这个请求、回一段音频，
就能接上，不需要改代码。

约束两条：明文 `http` 只放行 `localhost` / `127.0.0.1`（本地模型服务基本都是裸
http，但往公网明文发密钥不行）；单次响应上限 4 MB、单句 120 字。

合成在主进程做 —— 宠物窗是 `file://` 源够不着外部地址，而且密钥不该出现在页面里。
外接失败会退回系统音色并在控制台记一次原因（401 / 404 / 超时 / 空音频各不相同）：
静音是最糟的失败方式。密钥明文存在 `~/.dsh/settings.yaml`。

要接的服务如果不说这套协议（比如火山引擎、Azure 原生 REST、GPT-SoVITS 的原生
接口），需要在中间放一个转换层，或者在 `desktop/host/tts-http.js` 里加一个分支。

**关于初音未来的声音**：接不了，也没打算内置。Miku 是**歌声**合成器，官方从来没有
中文语音合成产品；社区那些克隆音色是拿 Vocaloid 音源训的，而 Crypton 的 CC BY-NC
授的是**角色**（形象、名字、外观）**不含声音** —— 音源是另一份商业软件授权。
接什么音色是使用者自己的事。

## 从源码构建

需要 Node 24 以上（`pnpm` 由 `npx` 拉起，不必预装）。

```sh
npm run setup     # 装 harness 与 desktop 的依赖
npm run build     # 构建 harness → 产出运行时闭包 → 打出安装包
```

安装包落在 `dist/`。想直接跑而不打包：

```sh
npm run build:harness
npm run build:runtime
npm start
```

`runtime/` 是安装包里真正被执行的那份 harness：一棵扁平、无符号链接的
node_modules。这两个性质不是偏好 —— Cordis 的 loader 按真实文件路径解析插件，
链接一旦是绝对路径，闭包拷进安装包就全断了。`tools/build-runtime.js` 会在产出后
自检并把缺的包补齐。

平台目标：`npm run build:win` / `build:mac` / `build:linux`。macOS 的包只能在
macOS 上构建，且本仓库不配代码签名 —— 未签名的包能跑，但首次打开会被 Gatekeeper
或 SmartScreen 拦一次。

## 配置模型

首次启动后打开 **设置 → 模型**。

**DeepSeek 官方 API** —— 在 DeepSeek 卡片里填入 API key，保存即可。密钥是只写的：保存后界面只拿得到脱敏描述符，明文存在 `~/.dsh/.credentials.yaml`，设置里只留一个引用。

**本地模型**（Ollama / vLLM / LM Studio）—— 选**添加自定义提供方**，填：

| 字段 | 例（Ollama） |
|---|---|
| Provider ID | `ollama` |
| API 协议 | `openai-completions` |
| 基础 URL | `http://127.0.0.1:11434/v1` |
| 模型 | 你本地拉过的那些 |

「获取可用模型」会打 `GET /models`，Ollama 与 vLLM 都支持，能直接把本地模型列出来。

本地服务通常还需要两个兼容开关，表单里没有，要写进 `~/.dsh/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    ollama:
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      compat:
        supportsDeveloperRole: false   # 多数本地服务不认 role: developer
        maxTokensField: max_tokens     # 只认 max_tokens，不认 max_completion_tokens
      models:
        - id: qwen3-coder:30b
```

无需认证的本地服务**不要写 `apiKeyEnv`** —— 写了却解析不出值会直接以 `MISSING_CREDENTIAL` 失败，整行删掉才表示"这条路由不认证"。

## 界面

- **强调色** —— 菜单里六档可选，切换即时生效
- **中英文** —— 菜单和设置里都能切，两个入口共用一份状态
- **深浅色** —— 设置 → 外观，可跟随系统

## 它是怎么搭起来的

```
渲染进程 (dsh://app)
  ├─ 页面 / assets / plugins / api ──protocol.handle──┐
  └─ 两条下行流 ──preload IPC──► 主进程 ─────────────┤
                                                     └─► 命名管道 ─► utilityProcess(harness)
```

三处不显然的决定：

- **harness 跑在 utilityProcess，不是主进程。** Cordis 的 loader 需要 Node 内部的 ESM 加载器才能相对 baseUrl 解析插件，而 Electron 的 V8 嵌入不暴露它所需的符号。utilityProcess 跑的是真实 Node 且接受 `execArgv`，带 `--expose-internals` 即可。附带好处是 harness 崩溃与界面天然隔离。
- **载体是命名管道，不是 TCP 端口。** 目标是"没有网络端口"，不是"不用 http"。管道让 `req`/`res` 保持为货真价实的 node 对象，上游的 bridge 因此拿到它期待的一切；而管道没有端口号，远程不可达。
- **不 fork 上游。** 上游的 `/api` 路由、信任栅栏与特权方法表都长在 `client-connection` 里，而它 inject 了 `webServer`。这里换掉它依赖的那个服务而不是改它，于是上游此后对这些策略的任何修改都自动继承 —— 没有一行安全逻辑被复制。

完整的探查记录在 [docs/architecture-findings.md](docs/architecture-findings.md)，十二条实测结论，每条都反直觉。

## 从源码运行

```sh
git clone https://github.com/GORXE111/DeepSeekClient.git
cd DeepSeekClient
npm install
npm start
```

对着 harness 源码仓库开发时，用 `DSH_DESKTOP_REPO` 指过去即可。

## 打包

```sh
npm run build:win     # NSIS 安装包
npm run build:mac     # dmg（必须在 macOS 上执行）
npm run build:linux   # AppImage
```

产物**未签名**：macOS 首次打开会被 Gatekeeper 拦（右键→打开可绕过），Windows 会弹 SmartScreen。去掉这些警告需要真实的开发者证书，不是配置能解决的。

## 已知事项

- 上游处于 developer preview 且明说会有破坏性变更。运行时版本在 `package.json` 里**钉死精确值**而不是跟 dist-tag —— 上游的 `latest` 标签目前停在一个旧纪元，按它装会得到版本错配的树。
- 中文输入法在输入过程中看不见正在组的字，这是上游的缺陷，已提交给上游（[Discussion #3607](https://github.com/deepseek-ai/deepseek-harness/discussions/3607)），合并前本客户端会带着它。
- 命名管道的默认 ACL 允许本机其他进程连接，与回环 TCP 端口同级。收紧需要每次启动生成共享密钥头，属于后续工作。

## 许可

MIT。上游 DeepSeek Harness 亦为 MIT，版权归 DeepSeek AI；本项目在运行时启动它，并未包含其源码。
