# DeepSeek Client

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端。前后端在一个包里，装完就能用 —— 你只需要配一个 API key，或者指向自己机器上的本地模型。

没有浏览器标签页，没有要记的端口号，**运行时不监听任何网络端口**。

## 安装

```sh
npm install -g deepseek-client
deepseek-client
```

国内网络下 Electron 的二进制可能下不动，先设个镜像：

```sh
npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
npm install -g deepseek-client
```

需要 Node 22.19 以上。

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
