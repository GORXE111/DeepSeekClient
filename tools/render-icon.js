'use strict'
// 把 build/icon.svg 光栅化成 build/icon.png（1024×1024）。
// electron-builder 会据此自动生成 .ico 与 .icns，所以只维护一份矢量源。
// 用 Electron 自己渲染而不是引入图形库：这台机器上已经有 Chromium 了。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const SIZE = 1024
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
  app.exit(0)
})
