'use strict'

/** 外观面板的窄接口：读一次当前状态，之后每次改动推给主进程立刻应用。 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshAppearance', {
  /** 面板打开时取当前生效的外观与主题清单。 */
  init: () => ipcRenderer.invoke('dsh:appearance-init'),
  /** 每次改动立刻应用并落盘 —— 外观是看着调的，没有"确定"这一步。 */
  update: (state) => { ipcRenderer.send('dsh:appearance-update', state) },
  /** 原生文件选择器只能由主进程打开。 */
  pickImage: () => ipcRenderer.invoke('dsh:appearance-pick-image'),
})
