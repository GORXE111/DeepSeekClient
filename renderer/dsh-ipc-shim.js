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

  console.info('[dsh-shim] 已安装：下行流改道 IPC')
})()
