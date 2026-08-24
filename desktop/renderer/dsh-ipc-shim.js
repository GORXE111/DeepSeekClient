/**
 * 主世界垫片：把两条下行流从 WebSocket 改道到 IPC。
 *
 * 上游把载体写死在客户端插件里（`new WebApiClient()`，只留了一个 ?fixture
 * 测试逃生口），所以没有注入点。但它脚下只有两个全局：`fetch` 与
 * `WebSocket`。unary 那半边已由自定义协议接管（同源 fetch 自然落进
 * protocol.handle），所以这里只剩 WebSocket —— 自定义协议没有 ws 对应物。
 *
 * 判据是**路径**而不是权威：上游那句 `url.protocol = 'ws:'` 未必生效（URL
 * 规范限制 scheme 之间的互换），所以不能指望拿到的是 ws: 开头的地址。只看
 * `/api/` 路径，与 scheme 无关。
 *
 * 只做下行：上游明确"客户端不会在这两条 socket 上发送业务数据"，因此
 * WebSocket 垫片不实现 send()，调用它会抛错而不是静默丢弃。
 */
;(() => {
  const ipc = globalThis.__dshIpc
  if (ipc === undefined) {
    // 没有桥就什么都不做：让页面按原样失败，而不是变成一个更难查的假象。
    console.error('[dsh-shim] 缺少 __dshIpc 桥，未安装垫片')
    return
  }

  /** 取 pathname 时基址随便给一个：只有路径参与判断。 */
  const pathOf = (raw) => {
    try { return new URL(String(raw), 'http://dsh.internal').pathname } catch { return undefined }
  }
  const isTarget = (raw) => {
    const p = pathOf(raw)
    return p !== undefined && p.startsWith('/api/')
  }

  // ---------------------------------------------------------------- WebSocket

  const NativeWebSocket = globalThis.WebSocket

  class ShimWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = ShimWebSocket.CONNECTING
    url

    #streamId
    #closed = false

    constructor(url) {
      super()
      this.url = String(url)
      // 事件处理器属性（onopen/onmessage/onclose）与 addEventListener 都要支持：
      // 上游用的是 addEventListener，但保留属性形式以免别处用到时静默失效。
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
      void this.#open()
    }

    async #open() {
      const path = pathOf(this.url)
      try {
        this.#streamId = await ipc.openStream({ path }, {
          onOpen: () => {
            if (this.#closed) return
            this.readyState = ShimWebSocket.OPEN
            this.#emit('open', {})
          },
          onFrame: (text) => {
            if (this.#closed) return
            this.#emit('message', { data: text })
          },
          onClose: () => { this.#finish() },
        })
      } catch (err) {
        this.#emit('error', { message: String(err) })
        this.#finish()
      }
    }

    #emit(type, detail) {
      const event = Object.assign(new Event(type), detail)
      const handler = this[`on${type}`]
      if (typeof handler === 'function') handler.call(this, event)
      this.dispatchEvent(event)
    }

    #finish() {
      if (this.#closed) return
      this.#closed = true
      this.readyState = ShimWebSocket.CLOSED
      this.#emit('close', { code: 1000, reason: '' })
    }

    close() {
      if (this.#closed) return
      this.readyState = ShimWebSocket.CLOSING
      if (this.#streamId !== undefined) ipc.closeStream(this.#streamId)
      this.#finish()
    }

    send() {
      // 上游从不在下行流上发业务数据。真有人发，说明假设变了 —— 该炸而不是静默。
      throw new Error('[dsh-shim] 下行流不支持 send()')
    }
  }

  globalThis.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      // 上游传的是 URL 对象而不是字符串，而且它那句 `url.protocol = 'ws:'` 在
      // file: URL 上按 URL 规范是静默无效的（file 与 ws 之间不允许改 scheme），
      // 所以这里既不能只认字符串，也不能指望协议已经是 ws:。统一转成字符串、
      // 只看路径。
      const url = args[0]
      const raw = url === undefined ? undefined : String(url)
      if (raw !== undefined && isTarget(raw)) return new ShimWebSocket(raw)
      return Reflect.construct(target, args)
    },
  })


  // ---------------------------------------------------------------- 标题栏

  /**
   * 插入应用自己的标题栏。
   *
   * 关键决定：这条栏**真实占位**，把应用内容整体下推，而不是浮在上面。
   * 覆盖式的拖拽条写起来简单，但它会挡住下面那一排真实控件 —— 侧边栏顶部的
   * 品牌按钮、折叠按钮、会话视图的标签页全在这个高度上。挡住之后点不动，
   * 而且症状是"这个按钮偶尔没反应"，极难查。
   *
   * 高度由主进程给（window.__dshTitlebarHeight）：Windows 的系统按钮覆盖层
   * 按同一个值定高，两边各写一个数就会错开一条缝。
   */
  const titlebarHeight = Number(globalThis.__dshTitlebarHeight) || 36

  const chrome = document.createElement('style')
  chrome.textContent = `
    :root { --dsh-titlebar-h: ${titlebarHeight}px; }

    /* 应用根节点让出标题栏的高度。上游按 100vh 铺满，不减掉这一段的话
       底部会被顶出视口，出现一条永远滚不到的溢出。

       整页必须锁死，只允许应用内部的面板滚动。让出的这 36px 若按 content-box
       计算，会把文档撑得比视口正好高出一个标题栏 —— 于是整页多出 36px 可滚
       余量，一滑，应用头部就滑到标题栏底下，与 Windows 的窗口按钮叠在一起。
       症状是"Session log 按钮和最小化/关闭撞了"，看上去像布局错位，实际是整页
       在滚。border-box + overflow:hidden 把这段余量从根上消掉。 */
    html { height: 100%; }
    body {
      box-sizing: border-box !important;
      height: 100% !important;
      overflow: hidden !important;
      padding-top: var(--dsh-titlebar-h) !important;
    }
    #root { height: 100% !important; }

    .dsh-titlebar {
      position: fixed; top: 0; left: 0; right: 0;
      height: var(--dsh-titlebar-h);
      display: flex; align-items: center;
      /* macOS 的红绿灯在左上，给它让出位置；Windows 的系统按钮在右上，
         由 titleBarOverlay 自己占，这里不必留。 */
      padding-left: ${navigator.userAgent.includes('Mac') ? '78px' : '12px'};
      gap: 8px;
      font: 500 12.5px/1 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      color: color-mix(in srgb, currentColor 45%, transparent);
      -webkit-app-region: drag;
      -webkit-user-select: none; user-select: none;
      z-index: 2147483000;
    }
    /* 栏内若放可点的东西，必须显式退出拖拽区，否则点不动。 */
    .dsh-titlebar button, .dsh-titlebar a { -webkit-app-region: no-drag; }

  `
  document.head.appendChild(chrome)

  const bar = document.createElement('div')
  bar.className = 'dsh-titlebar'

  bar.textContent = 'DeepSeek Client'
  // 等 body 存在再插；垫片跑在页面脚本之前，这时 body 可能还没有。
  const mountBar = () => { document.body?.appendChild(bar) }
  if (document.body) mountBar()
  else document.addEventListener('DOMContentLoaded', mountBar, { once: true })

  // ---------------------------------------------------------------- 品牌

  /**
   * 换掉侧边栏里的兜底品牌名。
   *
   * 上游有三个品牌插槽（sidebar.brand.mark / sidebar.brand.name /
   * conversation.hero.brand.mark），"DSH Local Build" 只是没人填时的兜底 ——
   * 那个 class 就叫 fallbackBrandName。正规做法是写一个客户端品牌插件把插槽填上，
   * 但客户端插件要走 /plugins 打包管线，是另一摊工程。
   *
   * 在那之前用 CSS 顶掉：纯样式、不动 DOM，因此不会被 React 的重渲染擦掉，也
   * 不会和上游的状态管理打架。class 名是 CSS Module 哈希过的，所以按包含匹配；
   * 上游哪天改了名，效果是退回显示原文，而不是崩掉。
   */
  const style = document.createElement('style')
  style.textContent = `
    [class*="fallbackBrandName"] { font-size: 0 !important; }
    [class*="fallbackBrandName"]::after {
      content: "DeepSeek Client";
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    /* 构建号是上游的版本标记，对这个产品的用户没有意义。 */
    [class*="buildRevision"] { display: none !important; }
  `
  document.head.appendChild(style)

  console.info('[dsh-shim] 已安装：下行流改道 IPC')
})()
