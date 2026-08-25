'use strict'

/**
 * 宠物窗的窄接口。
 *
 * 页面只表达意图，怎么处理由主进程决定 —— 窗口该多大、菜单里放什么、消息发给
 * 哪个会话，都不是一个悬浮小圆点该知道的事。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshPet', {
  /**
   * 改窗口尺寸。返回 Promise，页面要等它完成再播动画。
   * @param {'idle'|'bubble'|'open'} mode 三档之一
   * @param {number} [height] 气泡那一档由页面量出来的高度；另两档忽略
   */
  resize: (mode, height) => ipcRenderer.invoke('dsh:pet-resize', mode, height),
  /** 右键菜单必须由主进程绘制，页面画不了原生菜单。 */
  /**
   * 按增量挪窗口。拖拽期间每一帧一条，所以走 send 而不是 invoke —— 不需要回执，
   * 而等待回执会把移动压在 IPC 往返上，宠物跟不上光标。
   */
  moveBy: (dx, dy) => { ipcRenderer.send('dsh:pet-move', dx, dy) },

  menu: () => { ipcRenderer.send('dsh:pet-menu') },
  /**
   * 发一句话。
   * @returns {Promise<{ok: true} | {ok: false, error: string}>}
   *   失败原因要能回到页面上说给用户听，不能只在主进程日志里。
   */
  ask: (text) => ipcRenderer.invoke('dsh:pet-ask', text),

  /**
   * 告诉主进程"素材解码完了，可以画了"。
   *
   * 有这一句是因为窗口建出来到页面能接消息之间有几百毫秒，主进程在那期间推的
   * 首帧状态没有接收方。以前靠 executeJavaScript 的失败回调把它悄悄吞掉，于是
   * 宠物一开始永远是待机的 —— 哪怕开它的时候智能体正在跑。现在反过来由页面来
   * 要，什么时候准备好由准备好的那一方说了算。
   */
  ready: () => { ipcRenderer.send('dsh:pet-ready') },

  /* 下面三条是主进程 → 页面的单向推送。用 contextBridge 暴露订阅函数而不是让
     preload 直接去调页面的全局：contextIsolation 开着，两边的 window 不是同一
     个对象，preload 根本够不着页面里的东西。 */

  /** 订阅"说一句话"。 */
  onSay: (fn) => { ipcRenderer.on('dsh:pet-say', (_e, text, ms) => { fn(text, ms) }) },
  /** 订阅"插播一次性动画"。 */
  onPlay: (fn) => { ipcRenderer.on('dsh:pet-play', (_e, anim) => { fn(anim) }) },
  /** 订阅状态变化。 */
  onState: (fn) => { ipcRenderer.on('dsh:pet-state', (_e, state) => { fn(state) }) },
})
