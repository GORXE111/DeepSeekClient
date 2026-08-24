'use strict'

/**
 * 渲染进程与主进程之间唯一的缝。
 *
 * 只暴露三个动作，不暴露 `ipcRenderer` 本身：contextBridge 的价值在于页面拿到
 * 的是一份窄接口，而不是一个可以对任意通道发消息的句柄。主世界的垫片
 * （renderer/dsh-ipc-shim.js）架在这三个动作之上，把上游 WebApiClient 发往
 * dsh.internal 的流量改道过来。
 */

const { contextBridge, ipcRenderer } = require('electron')

/** 每条下行流一份回调，按渲染侧生成的 id 索引。 */
const streams = new Map()
let nextStreamId = 1

ipcRenderer.on('dsh:stream-open', (_e, id) => { streams.get(id)?.onOpen?.() })
ipcRenderer.on('dsh:stream-frame', (_e, id, text) => { streams.get(id)?.onFrame?.(text) })
ipcRenderer.on('dsh:stream-close', (_e, id) => {
  const s = streams.get(id)
  streams.delete(id)
  s?.onClose?.()
})

contextBridge.exposeInMainWorld('__dshIpc', {
  /**
   * 一次 unary 调用。
   * @param {{path: string, method: string, body?: string}} req
   * @returns {Promise<{status: number, body: string, headers?: Record<string,string>, error?: string}>}
   */
  unary: (req) => ipcRenderer.invoke('dsh:unary', req),

  /**
   * 打开一条下行流。回调经 contextBridge 代理回主世界。
   *
   * id 由这一侧生成而不是等主进程返回：主进程完成握手后可能立刻推帧，而
   * `invoke` 的 resolve 要等一个微任务 —— 那之间到达的帧会找不到 sink 被丢掉。
   * 先登记、再发起，这条竞态就不存在。
   *
   * @param {{path: string}} req
   * @param {{onOpen?: () => void, onFrame?: (text: string) => void, onClose?: () => void}} sinks
   * @returns {Promise<number>} 流 id，用于 closeStream
   */
  openStream: async (req, sinks) => {
    const id = nextStreamId++
    streams.set(id, sinks)
    try {
      await ipcRenderer.invoke('dsh:stream-open', { ...req, id })
    } catch (err) {
      streams.delete(id)
      throw err
    }
    return id
  },

  /**
   * 订阅强调色变化。壳改了强调色之后页面要立刻跟上，重载会丢掉正在编辑的
   * 内容，所以走推送而不是刷新。
   */
  /**
   * 订阅外观变化。改了外观之后页面要立刻跟上，重载会丢掉正在编辑的内容，
   * 所以走推送而不是刷新。
   */
  onAppearance: (cb) => { ipcRenderer.on('dsh:appearance', (_e, look) => { cb(look) }) },

  /** 关闭一条下行流；重复关闭是安全的。 */
  closeStream: (id) => {
    streams.delete(id)
    ipcRenderer.send('dsh:stream-close-request', id)
  },
})
