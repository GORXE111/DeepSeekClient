# 架构探查结论

把 DeepSeek Harness 装进桌面客户端的过程中，逐条实测出来的事实。每条都对应一个可重跑的探针，写在这里是因为它们全都违反直觉 —— 不留档下次还要重踩一遍。

环境：Electron 43.4.1（内置 Node 24.18.1，ABI 148）· Windows 11 · harness `v0.1.0-rc.8`

## 1. Electron 主进程无法引导 harness

Cordis 的 loader 要相对一个 `baseUrl` 解析插件，为此它需要拿到 Node 内部的 ESM 加载器（`internal/modules/esm/loader` 的 `getOrInitializeCascadedLoader()`），途径有两条：`--expose-internals`，或原生插件 `node-addon-require-builtin`。

在 Electron 主进程里两条都不通：

```
node-addon-require-builtin  加载成功（ABI 没问题）
requireBuiltin              失败 → Unsupported/no-realm
                                  (no compatible GetAlignedPointerFromEmbedderData symbol found)
```

拿不到内部加载器时，loader 退回裸 `import()`，从 `vendor/loader/lib/` 解析 —— **每一个插件包都找不到**。

## 2. `utilityProcess` 可以

`utilityProcess.fork()` 跑的是真实 Node，并且接受 `execArgv`：

```js
utilityProcess.fork(child, [], { execArgv: ['--expose-internals'] })
```

实测：完整引导 3.2s，`toFetchHandler(ctx.apiProxy)` 直连成功，`host.describe` 与 `settings.describe` 均返回 200，全程不经 fetch / socket / 端口。

**这决定了整个产品的进程拓扑**：渲染进程 ←IPC→ 主进程 ←MessagePort→ utilityProcess(harness)。附带好处是 harness 崩溃与 UI 天然隔离。

## 3. `utilityProcess` 的 `stdio: 'inherit'` 不转发输出

`console.log` / `console.error` 在 utilityProcess 里等于哑掉。唯一可靠的通道是 `process.parentPort.postMessage`。

这条坑得最狠：曾据此误判"模块从未被加载"，实际是加载了但看不见。**在 utilityProcess 里调试，第一件事是把诊断改成 postMessage。**

## 4. 补丁不能覆盖 entry 的 `name`

写了不报错，但**静默忽略**：

```yaml
- id: webserver
  name: '@dsh-desktop/webserver-ipc'   # 无效
```

实测在位的仍是上游 `WebServer`，端口 3080 照开。要换实现只能禁用原 entry 再插入：

```yaml
- id: webserver
  disabled: true

- insert:
    - id: webserver-ipc
      name: '@dsh-desktop/webserver-ipc'
```

`- insert:` 是上游 bundle 自己使用的语法（见 `packages/bundle/web-app/cordis.patch.yml`）。

## 5. 零 fork 路径成立

`client-connection` 声明 `inject = ['webServer']`，而 `/api` 路由、WebSocket upgrade 与 `PRIVILEGED_METHODS` 表全长在它的 apply 里。

不需要 fork 它 —— 换掉它依赖的 `webServer` 服务即可。上游插件原样加载，把真正的路由注册进替身，桌面端再把请求喂给同一个处理器。

上游此后新增或收紧任何策略，桌面端自动继承。**没有一行安全逻辑被复制** —— 这对一个要长期跟随 rc 阶段上游、且上游不收 PR 的产品是决定性的。

替身本身刻意保持"哑"：只做登记与路径匹配（精确 → 最长前缀 → fallback，与上游同序），不判断谁能调什么。那是上游路由处理器的职责，把它留在原处正是本设计的全部意义。

请求怎么送到那个处理器，见第 10 条 —— 一度试过伪造 node 对象，行不通。

## 6. 信任栅栏拒绝 `Origin: null`

`api-request-trust.ts` 三层判定：Host 必须是回环或 `trustedHosts` 之一；`sec-fetch-site: cross-site` 一律拒；有 `Origin` 就必须与 Host 一致，**字面量 `"null"` 直接拒**。

`file://` 页面发出的 fetch 携带的正是 `Origin: null`，所以**渲染进程直连本地 API 走不通，IPC 是唯一的路**。这已用可运行实验验证（详见 `spike.html`：直连得 403，IPC 得 200）。

推论：IPC 桥在主进程侧合成请求时，必须显式带回环 `Host`、不带 `Origin` 与 `Sec-Fetch-*`。这样特权方法那道 `isTrustedApiRequest(request, [])` **正常放行而不是被绕过** —— 绕过的话那张表会静默失效。

## 7. 原生依赖不是障碍

- **node-pty** 在 Electron 里加载成功（导出 `native, spawn, fork, createTerminal`），ABI 兼容
- **sqlite** 用的是内置 `node:sqlite`，不是原生模块

## 8. `apps/cli` 没有 `exports` 字段

只有 `bin`，所以拿不到 `runProfile` 的包名入口；构建产物又按内容哈希命名（`profile-boot-XXXXXXXX.js`）。

目前按内容特征识别门面块（只做一次再导出的那个）。**产品里应改成打包时固化，而不是运行时猜。**

## 9. 替身方案已跑通到"路由捕获"

带替身引导 **成功完成**，且上游把真正的路由注册了进来：

```
路由表   = [prefix:/plugins | exact:/plugins/events | prefix:/api]
fallback = 已注册
```

`/api/...` 匹配到的是具名路由而非 fallback。**零 fork 的核心假设至此被证实。**

同一次引导内，两条对照都正常：

| 路径 | 结果 |
|---|---|
| 直连 `toFetchHandler(ctx.apiProxy)` | HTTP 200 |
| `ctx.connection.createSharedFetchHandler('/api', …)` | HTTP 200 |

所以引导健康、apiProxy 健全、共享处理器工作正常。

## 10. 载体用命名管道，不要伪造 node 对象

伪造 `IncomingMessage`/`ServerResponse` 喂给上游路由处理器**行不通**：请求体读完之后、响应产生之前挂住，而同一次引导里直连 `apiProxy` 和共享处理器都返回 200。用真实的 http server 打同一个 handler 则立刻 200，逐字段 diff 显示伪造的 `req` 缺 `socket`、`aborted`、`complete`、`httpVersion`、`rawHeaders`、`connection`、`trailers`。

补字段是条没有尽头的路：缺什么取决于上游此刻读了什么，而那会变。

**改用真实的 node http server，监听命名管道而不是 TCP 端口。** `req`/`res` 因此是货真价实的对象，上游拿到它期待的一切，我们零维护、永不漂移；而管道没有端口号，远程不可达 ——「无端口」的目标依然成立，代价只是一次本地管道往返。

实测（`host/harness-host.js` + `probe7`）：

```
引导完成，耗时 1003ms
管道 \\.\pipe\dsh-desktop-45008-d850eaed
  host.describe        HTTP 200 · ok
  settings.describe    HTTP 200 · ok     ← 特权方法照常放行
  llm.providers        HTTP 200 · ok
全程无 TCP 端口
```

安全姿态与原方案持平：命名管道的默认 ACL 允许本机其他进程连接，正如原来的回环 TCP 端口，而上游那道信任栅栏两种载体都照常生效。要更严需要每次启动生成共享密钥头 —— 属于后续工作，记在下面。

## 11. 两条下行流在管道上同样成立

`events.mux` / `events.host` 是 WebSocket upgrade 而不是普通请求。上游把它们注册成 upgrade 路由，替身照单收下，管道 server 按 pathname 转交 —— 协议握手与连接内容仍归上游的 handler，因为管道上的 socket 也是真的。

实测（`probe8`，手工完成 WebSocket 握手，因为标准客户端只认 URL、连不上管道）：

```
upgrade      /api/events.mux | /api/events.host
events.host  ✔ 握手成功（101 + Sec-WebSocket-Accept 校验通过） · 收到 4 帧
             {"type":"server-request", … "method":"host/remote-event" …}
events.mux   ✔ 握手成功 · 收到 8 帧
             {"type":"server-request", … "method":"session/subscribed" …}
             {"type":"server-request", … "method":"session/projection" …}
```

触发源用的是 `session.create`（推一条 `host/session-added`，不调用 LLM）。**握手通过不足以说明载体可用，帧真的流起来才算。**

至此整个载体在管道上完整可用：unary + 两条下行流，全程零 TCP 端口。

## 12. 渲染侧走自定义协议，不是 file://

上游 `resolveBase()` 显式处理了 `origin === 'null'` 的情形，看着正是为 `file://` 准备的，所以先试了那条路。三个问题接连暴露：

1. Chromium 给 `file://` 页面报的 origin 是 `"file://"` 而不是字面量 `"null"`，于是 `resolveBase()` 原样返回它，请求变成 `file:///api/...`。
2. 构建产物的资源是根绝对路径（`/assets/…`），`file://` 下 `/` 指向磁盘根，全部 `ERR_FILE_NOT_FOUND`。
3. 致命的一条：前端还要从 `/plugins/` 动态加载插件 bundle —— 那些不是 dist 里的文件而是服务器生成的，**且由 `<script>` 标签加载**。垫片只能拦 `fetch`，拦不到标签。

所以 `file://` 走不通。改用自定义 scheme（`dsh://app`）加 `protocol.handle`：渲染进程发出的每一个请求 —— 入口页、assets、`/plugins` bundle、`/api` 调用 —— 都从同一处转发到管道，页面也因此有了正常的同源关系。

连带好处：unary 的 fetch 垫片不再需要，同源 `fetch` 自然落进 `protocol.handle`。垫片只剩 WebSocket 一半（自定义协议没有 ws 对应物）。

还有两处踩到才知道的：

- **入口页不能直接读 `dist/index.html`**。服务器发出的那份是原始文件再经 `tapIndex` 变换，模块加载器门面与 `window.__DSH_BOOT__` 名单都在那一步注入；直接读会得到一个看似正常、实则报 `window.__ModuleLoader__ bootstrap facade is missing` 的空白页。经管道 `GET /` 取，等于让上游自己注入完。
- **注入垫片后要删掉 `content-length`**，否则响应被按旧长度截断。

实测：界面完整渲染，工作区与历史会话都在，模型选择器显示 DeepSeek-V4-Flash —— 侧边栏能有数据，说明下行流的 `session/projection` 帧确实送达。正常启动（不带调试端口）时 electron 监听的 TCP 端口数为 0。

## 历史：伪造 req/res 那条弯路

把上游捕获到的 `route.handler(req, res)` 用伪造的 node 对象喂进去，会停在一个精确的位置：

```
调用 route.handler  →  req.destroy()  →  （再无任何输出）
```

`req.destroy()` 来自 `for await (const chunk of req)` 结束时异步迭代器的清理，说明**请求体已完整读完**；而 `res.writeHead` / `write` / `end` 一个都没被调用，说明**响应一个字节都没产生**。中间只剩 `await apiHandler.fetch(request)` 这一步。

已排除的方向：

- **不是具体方法**：`host.describe` 与 `settings.describe` 表现一致（后者还是特权方法，走的判定分支不同）
- **不是 Request 的形状**：把 `bridge` 与手写版的三处差异（`dsh.internal` 基址、`content-length` 头、`signal`）逐个加回去做了四个变体，**全部返回 200**
- **不是引导状态**：上面两条对照在同一次引导里都是 200

对比法给出了答案：真实 req/res 打同一个 handler 立刻 200，伪造的不行。结论见上一节 —— 不补字段，改用命名管道。

## 待办

- **载体加共享密钥**：管道默认 ACL 允许本机其他进程连接，与原来的回环端口同级。每次启动生成一个随机头、由 harness 侧校验，可以把本机其他进程挡在外面。
- **门面块解析改为打包期固化**：见第 8 条。
- **打包**：electron-builder、Windows 签名、自动更新；harness 产物随包分发。
