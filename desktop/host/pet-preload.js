'use strict'

/**
 * 宠物窗的窄接口。
 *
 * 页面只表达意图，怎么处理由主进程决定 —— 窗口该多大、菜单里放什么、消息发给
 * 哪个会话，都不是一个悬浮小圆点该知道的事。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshPet', {
  /** 展开/收起时改窗口尺寸。返回 Promise，页面要等它完成再播动画。 */
  resize: (expanded) => ipcRenderer.invoke('dsh:pet-resize', expanded),
  /** 右键菜单必须由主进程绘制，页面画不了原生菜单。 */
  /**
   * 按增量挪窗口。拖拽期间每一帧一条，所以走 send 而不是 invoke —— 不需要回执，
   * 而等待回执会把移动压在 IPC 往返上，鱼跟不上光标。
   */
  moveBy: (dx, dy) => { ipcRenderer.send('dsh:pet-move', dx, dy) },

  menu: () => { ipcRenderer.send('dsh:pet-menu') },
  /**
   * 发一句话。
   * @returns {Promise<{ok: true} | {ok: false, error: string}>}
   *   失败原因要能回到页面上说给用户听，不能只在主进程日志里。
   */
  ask: (text) => ipcRenderer.invoke('dsh:pet-ask', text),
})
