'use strict'

/**
 * 主进程侧的载体：把渲染进程经 IPC 送来的请求转成命名管道上的真实 HTTP 流量。
 *
 * 请求头的形状是这里唯一需要动脑的地方。Host 写死回环、且不带 Origin 与
 * Sec-Fetch-*，于是上游那道信任栅栏与特权方法的 `isTrustedApiRequest(request, [])`
 * **正常放行，而不是因为缺少请求头被绕过**。这两者外部表现一样，含义天差地别：
 * 绕过的话那张特权方法表会静默失效，出了事也查不出来。
 *
 * @module pipe-bridge
 */

const http = require('node:http')
const { randomBytes, createHash } = require('node:crypto')

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 每个请求都带的回环身份。渲染进程无从伪造这些 —— 它只能提供 path 与 body。 */
const loopbackHeaders = () => ({ host: '127.0.0.1' })

/**
 * 服务端→客户端的帧不带掩码，解码只需处理 fin/opcode 与三段长度编码。
 * 只解文本帧；分片重组与控制帧应答留到有需要时再加（上游目前每帧一条完整
 * JSON，不分片）。
 */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor); cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8
    }
    if (masked) cursor += 4
    if (cursor + length > buffer.length) break
    if (opcode === 1) frames.push(buffer.subarray(cursor, cursor + length).toString('utf8'))
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * 转发一次任意请求，响应体保留为 Buffer。
 *
 * 渲染进程要的不只是 /api：入口页、assets，以及动态生成的 /plugins bundle
 * 都得从管道拿。后两者里有二进制与非 UTF-8 内容，所以这里绝不能转成字符串
 * —— 那会悄悄损坏字体和图片，而症状要到很晚才显现。
 *
 * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer, error?: string}>}
 */
function proxy(pipe, { path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(body)
    const request = http.request({
      socketPath: pipe,
      path,
      method,
      headers: {
        ...headers,
        ...loopbackHeaders(),
        ...payload === undefined ? {} : { 'content-length': payload.byteLength },
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: Object.fromEntries(
          Object.entries(response.headers).filter(([, v]) => typeof v === 'string'),
        ),
        body: Buffer.concat(chunks),
      }))
    })
    request.on('error', (err) => {
      resolve({ status: 502, headers: {}, body: Buffer.alloc(0), error: String(err.message) })
    })
    if (payload !== undefined) request.end(payload)
    else request.end()
  })
}

/** 一次 unary 调用。失败以 `{error}` 返回而不是抛出：渲染侧要能把它变成 TypeError。 */
function unary(pipe, { path, method = 'POST', body }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(body)
    const request = http.request({
      socketPath: pipe,
      path,
      method,
      headers: {
        ...loopbackHeaders(),
        'content-type': 'application/json',
        ...payload === undefined ? {} : { 'content-length': payload.byteLength },
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: Object.fromEntries(
            Object.entries(response.headers).filter(([, v]) => typeof v === 'string'),
          ),
        })
      })
    })
    request.on('error', (err) => { resolve({ status: 0, body: '', error: String(err.message) }) })
    if (payload !== undefined) request.end(payload)
    else request.end()
  })
}

/**
 * 打开一条下行流：在管道上完成 WebSocket 握手，把文本帧逐条交给 sinks。
 * @returns 关闭该流的句柄。
 */
function openStream(pipe, path, sinks) {
  const key = randomBytes(16).toString('base64')
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64')
  let socket
  let finished = false

  const finish = () => {
    if (finished) return
    finished = true
    sinks.onClose()
  }

  const request = http.request({
    socketPath: pipe,
    path,
    method: 'GET',
    headers: {
      ...loopbackHeaders(),
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
    },
  })

  request.on('upgrade', (response, sock, head) => {
    // 校验 accept：握手不对就当没连上，而不是让一条来路不明的连接开始推帧。
    if (response.headers['sec-websocket-accept'] !== expected) { sock.destroy(); finish(); return }
    socket = sock
    let buffer = Buffer.from(head)
    sinks.onOpen()
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const decoded = decodeFrames(buffer)
      buffer = decoded.rest
      for (const text of decoded.frames) sinks.onFrame(text)
    })
    sock.on('close', finish)
    sock.on('error', finish)
  })
  // 握手被拒（426/403…）与传输错误都以关闭收场：上游会重建这条 generation。
  request.on('response', (response) => { response.resume(); finish() })
  request.on('error', finish)
  request.end()

  return () => {
    if (socket !== undefined) socket.destroy()
    else request.destroy()
    finish()
  }
}

module.exports = { proxy, unary, openStream }
