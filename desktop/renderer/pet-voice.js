'use strict'

/**
 * 宠物的语音提醒。
 *
 * 用浏览器自带的 `speechSynthesis`：不联网、不要密钥、不额外打包任何东西。代价是
 * 音色就是系统里装了什么就有什么。
 *
 * **这里做不出初音未来的声音，也不打算做。** 三点，都很实在：
 *
 *  1. Miku 是**歌声合成器**，从来没有官方的中文语音合成产品。
 *  2. 社区那些克隆音色（GPT-SoVITS / RVC 之类）是拿 Vocaloid 音源训出来的。
 *     Crypton 的 CC BY-NC 授的是**角色**（形象、名字、外观），**不含声音** ——
 *     音源是另一份商业软件授权。所以那种模型不能随本项目分发。
 *  3. 就算不谈授权，那类模型要 Python 加几 GB 的权重，塞不进一个桌面壳。
 *
 * 于是这里的目标退一步：在系统现有的中文音色里挑一个**尽量年轻轻快**的，把语速
 * 调得利落一点，配上她本来就短促可爱的说话方式。是"听着像个爽利的小姑娘"，不是
 * "听着像 Miku"。想要后者，得接一个外部的神经网络音色服务，那是另一件事。
 *
 * 顺带记一笔实测结论，免得以后有人再走一遍：**Windows 上 `pitch` 是无效的**。
 * SAPI 的音调标记会让输出字节变化，但实测 −10..+10 整个范围里中位基频只在
 * 176–184 Hz 之间抖，听感几乎不动。所以这里不提供音调滑块 —— 一个拧了没反应的
 * 旋钮比没有更糟。语速是真的有用，只留它。
 *
 * 这个文件两边都要用：宠物窗当普通脚本加载它，主进程 `require` 它去清理要送给
 * 外接服务的文本 —— 文本清理规则只能有一份，两份迟早会分叉，而分叉的表现是同一
 * 句话本地念得好好的、外接服务念出一串"中圆点"。所以包成 UMD。
 *
 * @module pet-voice
 */

;((root, factory) => {
  const api = factory()
  if (typeof module === 'object' && module !== null && typeof module.exports === 'object') module.exports = api
  else root.__dshVoice = api
})(globalThis, () => {

/**
 * 中文音色的偏好顺序。
 *
 * Yaoyao 排第一：三个里它最年轻、最轻快。Huihui 是 Windows 的老牌中文音色，稳
 * 但偏成熟平板。Kangkang 是男声，排最后 —— 一个自称 MIKU 的桌面小人用男声说话
 * 太出戏，但有总比没有强。
 */
const PREFERRED = ['yaoyao', 'xiaoxiao', 'xiaoyi', 'huihui', 'kangkang']

/** 一次最多读多少字。再长没人听得下去，而且会盖住下一条提醒。 */
const MAX_CHARS = 120

/**
 * 挑一个音色。
 *
 * @param {Array<{name: string, lang: string}>} voices `speechSynthesis.getVoices()` 的结果
 * @param {string} preferred 用户在设置里选的名字；空串表示自动挑
 * @returns {object | null} 选中的音色；一个中文音色都没有时为 null
 */
function pickVoice(voices, preferred = '') {
  const list = Array.isArray(voices) ? voices : []
  // 用户明确选过就照办，哪怕它不是中文的 —— 那是他自己的选择。
  if (preferred !== '') {
    const exact = list.find((v) => v && v.name === preferred)
    if (exact !== undefined) return exact
    // 选过的音色可能已经被卸载了；这时候不要沉默地不出声，往下走自动挑选。
  }
  const chinese = list.filter((v) => v && typeof v.lang === 'string' && v.lang.toLowerCase().startsWith('zh'))
  if (chinese.length === 0) return null
  for (const key of PREFERRED) {
    const hit = chinese.find((v) => String(v.name).toLowerCase().includes(key))
    if (hit !== undefined) return hit
  }
  return chinese[0]
}

/**
 * 把气泡文本改写成适合念出来的样子。
 *
 * 气泡是给眼睛看的：多任务的报喜是一个标题加几行 `· 项目`。原样丢给合成器会念出
 * 一串"中圆点"，而换行会被当成句子边界产生长得离谱的停顿。
 *
 * @param {string} text 气泡原文
 * @param {number} [maxChars] 长度上限
 * @returns {string} 可以念的文本；没什么可念的时候是空串
 */
function speakable(text, maxChars = MAX_CHARS) {
  if (typeof text !== 'string') return ''
  const lines = text.split(String.fromCharCode(10))
    .map((line) => line.replace(/^[·・•\-*]\s*/, '').trim())
    .filter((line) => line !== '')
  // 用顿号把条目串起来：比句号短促，符合"一口气报几件事"的语气。
  let flat = lines.join('、')
  // 颜文字和波浪号是写给眼睛的，念出来是噪音。
  flat = flat.replace(/[~～]+/g, '').replace(/\s{2,}/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  // 从截断处往前找一个标点，别把词切一半。
  const cut = flat.slice(0, maxChars)
  const stop = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('、'))
  return stop > maxChars * 0.6 ? cut.slice(0, stop) : cut
}

/**
 * 念一句。
 *
 * 每次先 `cancel()`：提醒的价值在于当下这一条，上一条还没念完就该让位 —— 排队会
 * 让它越积越多，最后在念五分钟前的事。
 *
 * @param {object} deps
 * @param {SpeechSynthesis} deps.synth
 * @param {typeof SpeechSynthesisUtterance} deps.Utterance
 * @param {string} text 气泡原文
 * @param {{name?: string, rate?: number, volume?: number}} [opts]
 * @returns {boolean} 是否真的开口了
 */
function speak({ synth, Utterance }, text, opts = {}) {
  if (synth === undefined || synth === null) return false
  const line = speakable(text)
  if (line === '') return false
  const voice = pickVoice(synth.getVoices(), String(opts.name ?? ''))
  if (voice === null) return false

  synth.cancel()
  const utterance = new Utterance(line)
  utterance.voice = voice
  utterance.lang = voice.lang
  // 略快于常速：同一个音色，快一点就显得轻快年轻，慢一点就显得在念公告。
  utterance.rate = Math.min(2, Math.max(0.5, Number(opts.rate) || 1.1))
  utterance.volume = Math.min(1, Math.max(0, Number(opts.volume ?? 0.85)))
  synth.speak(utterance)
  return true
}

/** 正在放的那段外接音频。留着引用是为了下一条来时能掐掉。 */
let playing = null

/**
 * 放一段外接服务合成好的音频。
 *
 * 和本地音色同一条规矩：新的一条来了就掐掉旧的。提醒的价值在于当下这条。
 *
 * @param {string} dataUri 主进程合成好送过来的音频
 * @param {number} volume 0..1
 * @returns {boolean} 是否开始播放
 */
function playAudio(dataUri, volume) {
  if (typeof dataUri !== 'string' || !dataUri.startsWith('data:audio/')) return false
  if (playing !== null) { try { playing.pause() } catch { /* 已经放完了 */ } }
  const audio = new Audio(dataUri)
  audio.volume = Math.min(1, Math.max(0, Number(volume ?? 0.85)))
  playing = audio
  // 播放可能被浏览器策略拒绝（没有用户手势）。桌面壳里不该发生，但拒绝是一个
  // 被拒的 Promise，不接住会变成 unhandledrejection。
  void audio.play().catch((err) => { console.warn('[pet] 音频播放失败:', err) })
  return true
}

return { pickVoice, speakable, speak, playAudio, PREFERRED, MAX_CHARS }
})
