'use strict'

// 渲染进程与主进程之间唯一的缝。
//
// 这里刻意只暴露一个 call()，不暴露 ipcRenderer 本身：contextBridge 的价值在于
// 渲染进程拿到的是一份窄接口，而不是一个可以对任意通道发消息的句柄。方案 B 真正
// 落地时，AbstractApiClient 的子类就架在这个 call() 上，另外还要加两个只下行的
// 事件通道来顶替 events.mux / events.host 两条 WebSocket。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsh', {
  /**
   * 走 IPC 发一次 unary 调用。
   * @param {string} method RPC 方法名，例如 host.describe
   * @param {unknown} payload 业务载荷
   * @returns {Promise<{ok: true, status: number, body: unknown} | {ok: false, error: string}>}
   */
  call: (method, payload) => ipcRenderer.invoke('dsh:api', { method, payload }),

  /** 主进程当前把 harness 服务在哪个 origin —— 只给对照实验用。 */
  origin: () => ipcRenderer.invoke('dsh:origin'),
})
