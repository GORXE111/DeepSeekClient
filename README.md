# DeepSeekClient

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 收进一个原生桌面窗口 —— 没有浏览器标签页，没有要记的端口号。

目标是一个像 ChatGPT 桌面版那样的本地客户端：本地渲染、本地执行，模型可以接 DeepSeek 官方 API、任意 OpenAI 兼容网关，或者跑在自己机器上的 Ollama / vLLM / LM Studio。

> 状态：可用的早期版本。窗口、生命周期、进程管理都已就绪；彻底去掉本地端口的工作在进行中（见下方路线）。

## 运行

需要：

- **Node 22.19+ 或 24+** —— harness 的入口用到 `import.meta.main`，更旧的版本上它是 `undefined`，脚本会静默不执行且退出码为 0
- 一份构建好的 harness 仓库（`pnpm install && pnpm run build`）

```sh
npm install
npm start
```

默认从 `E:\DEEPSEEK\deepseek-harness` 找 harness、用 `E:\DEEPSEEK\node24\node.exe` 跑它。换成你自己的路径：

```sh
set DSH_DESKTOP_REPO=D:\code\deepseek-harness
set DSH_DESKTOP_NODE=C:\Program Files\nodejs\node.exe
npm start
```

## 它是怎么工作的

主进程把 harness 的 web profile 作为子进程拉起，让它绑到一个由内核挑选的空闲端口，再把窗口指向那个地址。

几个不是随手写的决定：

- **端口不写死。** `--port 0` 让内核挑，再从 harness 打印的那行 URL 解析回来。写死意味着第二个实例撞端口，也会和手动跑的 `dsh web` 冲突。
- **显式使用外部 Node，而不是 Electron 自带的那个。** Electron 内置的 Node 版本不保证 ≥22.19，一旦低于就会撞上上面那个静默失败，退出码还是 0，极难排查。顺带把 harness 的崩溃和壳隔离开。
- **退出用 `taskkill /T`。** Windows 上 `child.kill()` 只结束被 spawn 的那一个进程，它底下的进程会变成孤儿并继续占着端口。
- **单实例锁。** 两个壳会各拉起一份 harness，抢同一个 `DSH_HOME`。
- **窗口不是浏览器。** 外部链接交给系统浏览器，站内导航不许离开 harness 自己的 origin；渲染进程 `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`。

## IPC 载体

渲染进程通过 `preload.js` 暴露的一个窄接口和宿主说话，拿不到 `ipcRenderer` 本身。这不是洁癖 —— 它是彻底去掉 HTTP 那条路的前置条件。

harness 的 `/api` 有一道信任栅栏（DNS rebinding 与跨站防御）。它拒绝字面量为 `null` 的 `Origin`，而 `file://` 页面发出的请求携带的正是这个。**所以渲染进程直接 fetch 本地 API 是走不通的，IPC 是唯一的路。**

仓库里带了一个验证页，把这件事做成了可运行的实验而不是一句断言：

```sh
set DSH_DESKTOP_SPIKE=1
npx electron .
```

| | 实验 | 预期 | 实测 |
|---|---|---|---|
| A | `file://` 页面直接 fetch `/api` | 被拒 | HTTP 403 |
| B | 经 IPC 调 `host.describe` | 成功 | HTTP 200 |
| C | 经 IPC 调 `settings.describe`（特权方法） | 成功 | HTTP 200 |

实验 C 是关键。harness 把 `settings.*`、`credentials.*`、`host.openPath` 等特权方法**用一次空信任表的检查钉在回环上**，而那道检查读的是 HTTP 请求头。IPC 没有请求头，天然"绕过"。正确做法不是绕过，而是让它照常成立 —— 主进程合成请求时显式带回环 `Host`、不带 `Origin` 与 `Sec-Fetch-*`，于是特权方法的策略**原样生效**。

这个区别很要命：绕过的话那张特权方法表就成了摆设，而且是静默失效。

## 路线

当前版本的 IPC 桥内部仍然转发到子进程的 HTTP 端点 —— 渲染进程确实再也不碰网络（实验 A 证明它想碰也碰不到），但端口还在。

要让端口真正消失：

1. **把 harness 收进主进程**，`ipcMain.handle` 直接调 `toFetchHandler(ctx.apiProxy).fetch(request)`。渲染侧接口一个字都不用改 —— 载体可替换、协议不受影响，正是上面那个验证要证明的事。
2. **拆 harness 的 `client-connection` 插件。** 它 `inject = ['webServer']` 硬依赖 web 服务器，而 `/api` 路由、WebSocket upgrade 与特权方法表全长在同一个 apply 里。这是唯一需要改上游代码的地方。
3. **两条下行流。** 覆盖 `AbstractApiClient` 的 `openMux` / `openHost`，照搬 `WebApiClient.readWebSocket` 的形状（inbox + wake + abort 清理），把 WebSocket 换成 IPC push 通道。
4. **前端 dist 走 `file://`**，并把 `ElectronApiClient` 注入进去。

未验证的风险：Electron 内置 Node 能否满足 harness 的版本要求，以及 tsx/ESM 在 Electron 主进程里能否正常加载。如果不行，第 1 步就要换形态（例如主进程与 harness 之间走 stdio RPC）。

## 已知粗糙处

- 路径默认值是作者机器上的绝对路径，靠环境变量覆盖。应该改成相对解析或首次运行时引导。
- 尚未打包成可分发的安装程序；目前从源码运行。
- 只在 Windows 上验证过。

## 许可

MIT

上游 DeepSeek Harness 亦为 MIT，版权归 DeepSeek AI。本项目不包含其代码，只在运行时启动它。
