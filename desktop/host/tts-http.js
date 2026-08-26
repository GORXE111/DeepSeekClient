'use strict'

/**
 * 外接语音合成。
 *
 * 系统自带的中文音色只有 Huihui / Yaoyao / Kangkang 三个，都是十年前那批
 * SAPI 音色，念出来是"播报"而不是"说话"。想要真正可爱的声音只能往外接。
 *
 * **这里不绑定任何一家服务，也不内置任何音色。** 说的是 OpenAI 那套
 * `/v1/audio/speech`：请求体 `{model, input, voice}`，回一段音频字节。这套协议被
 * 抄得很广 —— Azure 的网关、SiliconFlow、Fish Audio、以及各种本地 GPT-SoVITS 的
 * HTTP 封装都认。于是"用哪个声音"变成一个设置项，而不是一次代码改动。
 *
 * 为什么不内置一个：
 *
 *  - 真·初音未来的声音不存在。Miku 是**歌声**合成器，官方从来没做过中文 TTS。
 *  - 社区那些克隆音色是拿 Vocaloid 音源训出来的。Crypton 的 CC BY-NC 授的是
 *    **角色**（形象、名字、外观），**不含声音** —— 音源是另一份商业软件授权。
 *    所以那种模型不能随本项目分发，哪怕本项目是非商业的。
 *  - 自己跑一个模型要 Python 加几 GB 权重，塞不进一个桌面壳。
 *
 * 接什么是使用者自己的事，这个模块只负责把文字换成字节。
 *
 * @module tts-http
 */

/** 一次请求最多等多久。等太久，提醒早就过时了。 */
const TIMEOUT_MS = 12000

/** 收到的音频最大字节数。一句提醒不该有几 MB。 */
const MAX_BYTES = 4 * 1024 * 1024

/** 念一句的字数上限，和本地音色那边一致。 */
const MAX_CHARS = 120

/** 认得的音频类型 → data URI 的 MIME。 */
const MIME = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/wav',
}

/**
 * 这份配置是不是齐的。
 *
 * 缺东西时要**说得出缺什么**：一个只会"没声音"的功能，用户无从判断是自己填错了
 * 还是根本没生效。
 *
 * @param {object} cfg 语音设置
 * @returns {string} 空串表示可用；否则是给人看的原因
 */
function checkConfig(cfg) {
  const url = String(cfg?.voiceUrl ?? '').trim()
  if (url === '') return '没填服务地址'
  let parsed
  try { parsed = new URL(url) } catch { return '服务地址不是合法的 URL' }
  // http 只放行本机：往公网明文发密钥不行，而本地跑的模型服务基本都是裸 http。
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      return '非本机地址请用 https，否则密钥会明文上网'
    }
  } else if (parsed.protocol !== 'https:') {
    return '只支持 http 与 https'
  }
  if (String(cfg?.voiceId ?? '').trim() === '') return '没填音色名'
  return ''
}

/**
 * 把一句话换成音频。
 *
 * @param {object} cfg 语音设置（voiceUrl / voiceKey / voiceModel / voiceId / voiceFormat / voiceRate）
 * @param {string} text 要念的文字，调用方已经清理过
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch] 注入用
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{ok: true, dataUri: string} | {ok: false, error: string}>}
 */
async function fetchSpeech(cfg, text, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  const line = String(text ?? '').slice(0, MAX_CHARS).trim()
  if (line === '') return { ok: false, error: '没什么可念的' }
  const bad = checkConfig(cfg)
  if (bad !== '') return { ok: false, error: bad }

  const format = MIME[cfg.voiceFormat] === undefined ? 'mp3' : cfg.voiceFormat
  const key = String(cfg.voiceKey ?? '').trim()
  // 超时靠 AbortController：没有它，一个不响应的服务会把这条提醒永远挂住，而下一
  // 条提醒还在后面排着。
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, timeoutMs)
  try {
    const response = await doFetch(cfg.voiceUrl, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        ...key === '' ? {} : { authorization: `Bearer ${key}` },
      },
      body: JSON.stringify({
        model: String(cfg.voiceModel ?? '').trim(),
        input: line,
        voice: String(cfg.voiceId).trim(),
        response_format: format,
        speed: Number(cfg.voiceRate) || 1,
      }),
    })
    if (!response.ok) {
      // 带上状态码：401 和 404 要用户做的事完全不同，只说"失败"帮不上忙。
      return { ok: false, error: `服务返回 HTTP ${response.status}` }
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length === 0) return { ok: false, error: '服务没有返回音频' }
    if (buf.length > MAX_BYTES) return { ok: false, error: '返回的音频过大' }
    // 走 data URI 而不是临时文件：宠物窗是 file:// 源，读不到我们写在别处的文件，
    // 而一句提醒的音频只有几十 KB，塞进一条 IPC 消息完全够用。
    return { ok: true, dataUri: `data:${MIME[format]};base64,${buf.toString('base64')}` }
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.name === 'AbortError') {
      return { ok: false, error: `服务超过 ${Math.round(timeoutMs / 1000)} 秒没响应` }
    }
    return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

/** 这条路由挂在哪个前缀下。 */
const ROUTE = '/__tts'

/**
 * 建一个处理 `/__tts` 的请求处理器。
 *
 * 设置面板的"试听"用它。面板跑在 dsh:// 页面里，直接去 fetch 一个外部服务会撞
 * CSP，而且密钥就摆在页面的网络记录里了；绕一趟壳，密钥只在主进程里出现。
 *
 * 只接受 POST：这是一次会向外发请求、会花钱的动作，不该能被一个 GET 链接触发。
 *
 * @param {object} [deps] 注入用
 * @returns {(request: Request) => Promise<Response>}
 */
function createTtsRoutes(deps = {}) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  return async (request) => {
    if (request.method !== 'POST') return json({ error: '不支持的方法' }, 405)
    let payload
    try { payload = JSON.parse(await request.text()) } catch { return json({ error: '请求不是 JSON' }, 400) }
    if (payload === null || typeof payload !== 'object') return json({ error: '请求不是 JSON' }, 400)
    const result = await fetchSpeech(payload, String(payload.text ?? ''), deps)
    return result.ok ? json({ dataUri: result.dataUri }) : json({ error: result.error }, 400)
  }
}

module.exports = { fetchSpeech, checkConfig, createTtsRoutes, ROUTE, TIMEOUT_MS, MAX_BYTES, MAX_CHARS, MIME }
