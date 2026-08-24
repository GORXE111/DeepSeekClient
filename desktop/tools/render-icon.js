'use strict'
// 把 build/icon.svg 光栅化成 build/icon.png（1024×1024）。
// electron-builder 会据此自动生成 .ico 与 .icns，所以只维护一份矢量源。
// 用 Electron 自己渲染而不是引入图形库：这台机器上已经有 Chromium 了。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/**
 * 除主图标外还渲染三枚托盘图标。托盘只有 16px，主图标那个深色底加两枚环缩到
 * 这个尺寸会糊成一团 —— 所以托盘用单枚实心环、无背景，只靠颜色区分状态。
 * 形状与主图标同源，但不是把它直接缩小。
 */
const TRAY = {
  idle: '#8e96a6',
  running: '#5b7cff',
  attention: '#e08a2b',
}

const SIZE = 1024

function trayMarkup(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <circle cx="32" cy="32" r="21" fill="none" stroke="${color}" stroke-width="9"/>
  </svg>`
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false,
    // 透明底：图标要在任何桌面背景上都对，不能烤进一块白。
    transparent: true, frame: false,
    webPreferences: { offscreen: true },
  })
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 600))
  const image = await win.webContents.capturePage()
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.writeFileSync(out, image.toPNG())
  console.log(`已生成 ${out} · ${image.getSize().width}×${image.getSize().height}`)

  // 托盘图标按 64px 渲染：16px 的显示尺寸下，高分屏要 2 倍图才不糊。
  const trayWin = new BrowserWindow({
    width: 64, height: 64, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true },
  })
  for (const [state, color] of Object.entries(TRAY)) {
    const markup = `<!doctype html><meta charset="utf-8">
      <style>html,body{margin:0;width:64px;height:64px;background:transparent}
      svg{display:block;width:64px;height:64px}</style>${trayMarkup(color)}`
    await trayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markup))
    await new Promise((r) => setTimeout(r, 200))
    const shot = await trayWin.webContents.capturePage()
    const file = path.join(__dirname, '..', 'build', `tray-${state}.png`)
    fs.writeFileSync(file, shot.toPNG())
    console.log(`已生成 ${file}`)
  }
  app.exit(0)
})
