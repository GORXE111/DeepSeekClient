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

不需要 fork 它 —— 换掉它依赖的 `webServer` 服务即可。上游插件原样加载，把真正的路由注册进替身，桌面端从 IPC 收到请求后合成 node 的 req/res 喂给同一个处理器。

上游此后新增或收紧任何策略，桌面端自动继承。**没有一行安全逻辑被复制** —— 这对一个要长期跟随 rc 阶段上游、且上游不收 PR 的产品是决定性的。

替身要伪造的 node 接口面很窄（上游 `http-bridge` 只触碰这些）：

```
req: method, url, headers, destroy
res: writeHead, write, end, on/once/off, writableEnded
```

都是 node http 里最稳定的成员，不随上游演进腐坏。

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

## 未决：伪造的 req/res 驱动上游路由处理器时挂住

把上游捕获到的 `route.handler(req, res)` 用伪造的 node 对象喂进去，会停在一个精确的位置：

```
调用 route.handler  →  req.destroy()  →  （再无任何输出）
```

`req.destroy()` 来自 `for await (const chunk of req)` 结束时异步迭代器的清理，说明**请求体已完整读完**；而 `res.writeHead` / `write` / `end` 一个都没被调用，说明**响应一个字节都没产生**。中间只剩 `await apiHandler.fetch(request)` 这一步。

已排除的方向：

- **不是具体方法**：`host.describe` 与 `settings.describe` 表现一致（后者还是特权方法，走的判定分支不同）
- **不是 Request 的形状**：把 `bridge` 与手写版的三处差异（`dsh.internal` 基址、`content-length` 头、`signal`）逐个加回去做了四个变体，**全部返回 200**
- **不是引导状态**：上面两条对照在同一次引导里都是 200

下一步建议不要再从外部试探，改为对比法：用**真实的 node http 请求**打同一个捕获到的 handler（临时起一个本地 server 把 req/res 转过去），与伪造对象逐字段 diff。嫌疑最大的是伪造的 `req` 只是个 `Readable`，缺少 `IncomingMessage` 的某些成员（如 `socket`、`aborted`、`complete`），而 `bridge` 之外的某一层读到了它们。
