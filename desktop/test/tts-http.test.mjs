/**
 * 外接语音合成的测试。
 *
 * 不碰网络：`fetch` 换成替身，只看**发出去的是什么**、**回来的怎么处理**。真连一
 * 个服务既要密钥又要花钱，还会让这套测试依赖别人的可用性。
 *
 * 重点在**失败路径**：这个功能失败时的默认表现是"没声音"，而没声音和"我没开这个
 * 功能"长得一模一样。所以每一种失败都必须能说出原因。
 *
 * 用法：node desktop/test/tts-http.test.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { fetchSpeech, checkConfig, createTtsRoutes, ROUTE } = require('../host/tts-http.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/** 一份填全了的配置。 */
const CFG = {
  voiceUrl: 'https://api.example.com/v1/audio/speech',
  voiceKey: 'sk-test',
  voiceModel: 'tts-1',
  voiceId: 'cute-girl',
  voiceFormat: 'mp3',
  voiceRate: 1.2,
}

/** 假的 fetch：记下请求，回一段指定的字节。 */
const fakeFetch = ({ bytes = Buffer.from([1, 2, 3]), status = 200, throws = null } = {}) => {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    if (throws !== null) throw throws
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  fn.calls = calls
  return fn
}

console.log('1) 配置检查说得出缺什么')
{
  // 一个只会"没声音"的功能，用户无从判断是自己填错了还是根本没生效。
  check('齐了就放行', checkConfig(CFG) === '')
  check('没填地址', checkConfig({ ...CFG, voiceUrl: '' }).includes('服务地址'))
  check('地址不是 URL', checkConfig({ ...CFG, voiceUrl: '这不是地址' }).includes('合法'))
  check('没填音色名', checkConfig({ ...CFG, voiceId: '  ' }).includes('音色名'))
  check('undefined 不炸', checkConfig(undefined) !== '')
}

console.log('2) 明文 http 只放行本机')
{
  // 往公网明文发密钥不行；而本地跑的模型服务基本都是裸 http，一刀切会把它们挡死。
  check('本机 http 放行', checkConfig({ ...CFG, voiceUrl: 'http://127.0.0.1:9880/v1/audio/speech' }) === '')
  check('localhost 放行', checkConfig({ ...CFG, voiceUrl: 'http://localhost:9880/tts' }) === '')
  check('公网 http 拦下', checkConfig({ ...CFG, voiceUrl: 'http://api.example.com/tts' }).includes('https'))
  check('https 放行', checkConfig({ ...CFG, voiceUrl: 'https://api.example.com/tts' }) === '')
  check('别的协议拦下', checkConfig({ ...CFG, voiceUrl: 'ftp://x/y' }).includes('只支持'))
  check('file 协议拦下', checkConfig({ ...CFG, voiceUrl: 'file:///etc/passwd' }).includes('只支持'))
}

console.log('3) 发出去的请求')
{
  const fetch = fakeFetch()
  const r = await fetchSpeech(CFG, '搞定啦', { fetch })
  check('成功', r.ok === true, JSON.stringify(r))
  const call = fetch.calls[0]
  check('POST', call.init.method === 'POST')
  check('地址对', call.url === CFG.voiceUrl)
  check('带 Bearer', call.init.headers.authorization === 'Bearer sk-test', String(call.init.headers.authorization))
  check('OpenAI 的字段名', call.body.model === 'tts-1' && call.body.voice === 'cute-girl', JSON.stringify(call.body))
  check('文本传对', call.body.input === '搞定啦', call.body.input)
  check('语速传对', call.body.speed === 1.2, String(call.body.speed))
  check('格式传对', call.body.response_format === 'mp3', call.body.response_format)
  check('回来的是 data URI', r.dataUri.startsWith('data:audio/mpeg;base64,'), r.dataUri.slice(0, 40))

  const noKey = fakeFetch()
  await fetchSpeech({ ...CFG, voiceKey: '' }, '喂', { fetch: noKey })
  check('没密钥就不发 authorization', noKey.calls[0].init.headers.authorization === undefined)
}

console.log('4) 每种格式都用对 MIME')
{
  for (const [format, mime] of [['wav', 'audio/wav'], ['opus', 'audio/ogg'], ['flac', 'audio/flac']]) {
    const r = await fetchSpeech({ ...CFG, voiceFormat: format }, '喂', { fetch: fakeFetch() })
    check(`${format} → ${mime}`, r.dataUri.startsWith(`data:${mime};base64,`), r.dataUri.slice(0, 30))
  }
  // 认不得的格式退回 mp3，而不是发一个服务方看不懂的值出去。
  const r = await fetchSpeech({ ...CFG, voiceFormat: '天知道' }, '喂', { fetch: fakeFetch() })
  check('认不得的格式退回 mp3', r.dataUri.startsWith('data:audio/mpeg;'), r.dataUri.slice(0, 30))
}

console.log('5) 失败都说得出原因')
{
  const cases = [
    ['401 带上状态码', fakeFetch({ status: 401 }), '401'],
    ['404 带上状态码', fakeFetch({ status: 404 }), '404'],
    ['500 带上状态码', fakeFetch({ status: 500 }), '500'],
    ['空音频', fakeFetch({ bytes: Buffer.alloc(0) }), '没有返回音频'],
    ['网络错误', fakeFetch({ throws: new Error('getaddrinfo ENOTFOUND') }), 'ENOTFOUND'],
  ]
  // Node 的 fetch 自己只说一句 "fetch failed"，真实原因在 cause 里。服务没开和
  // 域名写错要用户做的事完全不同，只报前者等于没报。
  const wrapped = new Error('fetch failed')
  wrapped.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9880'), { code: 'ECONNREFUSED' })
  cases.push(['连接被拒要说出 ECONNREFUSED', fakeFetch({ throws: wrapped }), 'ECONNREFUSED'])
  for (const [label, fetch, needle] of cases) {
    const r = await fetchSpeech(CFG, '喂', { fetch })
    check(label, r.ok === false && r.error.includes(needle), JSON.stringify(r))
  }

  const r = await fetchSpeech(CFG, '   ', { fetch: fakeFetch() })
  check('没什么可念的', r.ok === false && r.error.includes('念'), JSON.stringify(r))

  const big = await fetchSpeech(CFG, '喂', { fetch: fakeFetch({ bytes: Buffer.alloc(5 * 1024 * 1024) }) })
  check('音频过大', big.ok === false && big.error.includes('过大'), JSON.stringify(big))
}

console.log('6) 超时')
{
  // 没有超时的话，一个不响应的服务会把这条提醒永远挂住，而下一条还在后面排着。
  const hang = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
  const started = Date.now()
  const r = await fetchSpeech(CFG, '喂', { fetch: hang, timeoutMs: 60 })
  check('超时了', r.ok === false && r.error.includes('没响应'), JSON.stringify(r))
  check('真的没等满 12 秒', Date.now() - started < 2000, String(Date.now() - started))
}

console.log('7) 路由')
{
  const handle = createTtsRoutes({ fetch: fakeFetch() })
  const post = (body) => new Request('http://x' + ROUTE, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })

  let r = await handle(post({ ...CFG, text: '试听一下' }))
  check('POST 成功', r.status === 200)
  const body = await r.json()
  check('回 data URI', String(body.dataUri).startsWith('data:audio/'), String(body.dataUri).slice(0, 30))

  r = await handle(post({ ...CFG, voiceUrl: '', text: '喂' }))
  check('配置不全 400', r.status === 400)
  check('带上原因', String((await r.json()).error).includes('服务地址'))

  // 这是一次会向外发请求、会花钱的动作，不该能被一个 GET 链接触发。
  r = await handle(new Request('http://x' + ROUTE, { method: 'GET' }))
  check('GET 405', r.status === 405, String(r.status))

  r = await handle(new Request('http://x' + ROUTE, { method: 'POST', body: '{ 坏 json' }))
  check('坏 JSON 400', r.status === 400, String(r.status))
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
