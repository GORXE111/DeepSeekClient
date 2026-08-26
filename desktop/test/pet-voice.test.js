'use strict'

/**
 * 语音提醒的测试。
 *
 * 两件事值得测：**挑哪个音色**（装了什么因机器而异，选错就是不出声或者用男声念），
 * 和**念什么**（气泡是给眼睛看的，原样丢给合成器会念出一串"中圆点"）。
 *
 * 真的发声没法断言，所以 speechSynthesis 换成替身，只记录收到了什么。
 *
 * 用法：node desktop/test/pet-voice.test.js
 */

// 这个模块是 UMD：宠物窗当脚本加载，主进程和这里 require。文本清理规则因此只有
// 一份 —— 两份迟早分叉，而分叉的表现是本地念得好好的、外接服务念出一串"中圆点"。
const { pickVoice, speakable, speak } = require('../renderer/pet-voice.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/** 这台机器上实际装着的那三个（见 pet-voice.js 的偏好顺序）。 */
const WINDOWS = [
  { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Kangkang - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { name: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', lang: 'zh-CN' },
]

console.log('1) 挑音色')
{
  check('自动挑选偏好 Yaoyao', pickVoice(WINDOWS).name.includes('Yaoyao'), pickVoice(WINDOWS).name)
  // Yaoyao 是三个里最年轻轻快的；Huihui 稳但偏成熟平板。
  const noYao = WINDOWS.filter(v => !v.name.includes('Yaoyao'))
  check('没有 Yaoyao 就退到 Huihui', pickVoice(noYao).name.includes('Huihui'), pickVoice(noYao).name)
  // 男声排最后：一个自称 MIKU 的桌面小人用男声说话太出戏，但有总比没有强。
  const onlyMale = WINDOWS.filter(v => v.name.includes('Kangkang') || v.lang === 'en-US')
  check('只剩男声也用', pickVoice(onlyMale).name.includes('Kangkang'), pickVoice(onlyMale).name)

  check('用户选过就照办', pickVoice(WINDOWS, 'Microsoft Huihui - Chinese (Simplified, PRC)').name.includes('Huihui'))
  // 用户可以故意选英文音色，那是他自己的选择。
  check('选了英文的也照办', pickVoice(WINDOWS, 'Microsoft Zira - English (United States)').lang === 'en-US')
  // 选过的音色可能被卸载了；这时候不该沉默，退回自动挑选。
  check('选的音色没了就自动挑', pickVoice(WINDOWS, 'Microsoft 已卸载').name.includes('Yaoyao'))

  check('一个中文音色都没有 → null', pickVoice([{ name: 'Zira', lang: 'en-US' }]) === null)
  check('空列表 → null', pickVoice([]) === null)
  check('不是数组 → null', pickVoice(undefined) === null)
  check('列表里有脏数据也不炸', pickVoice([null, undefined, { name: 'Yaoyao', lang: 'zh-CN' }]).name === 'Yaoyao')
}

console.log('2) 念什么')
{
  const nl = String.fromCharCode(10)
  // 多任务的报喜是一个标题加几行「· 项目」。原样念会念出一串"中圆点"。
  const bubble = ['老大，你的 3 个任务都搞定啦~', '· 重构登录模块', '· 修 CSS', '· 写测试'].join(nl)
  const said = speakable(bubble)
  check('中圆点去掉了', !said.includes('·'), said)
  check('波浪号去掉了', !said.includes('~'), said)
  check('条目用顿号串起来', said === '老大，你的 3 个任务都搞定啦、重构登录模块、修 CSS、写测试', said)

  check('单行原样', speakable('出错啦，去看看？') === '出错啦，去看看？')
  check('空行丢掉', speakable(['甲', '', '  ', '乙'].join(nl)) === '甲、乙')
  check('别的项目符号也去掉', speakable('- 甲' + nl + '* 乙' + nl + '• 丙') === '甲、乙、丙')
  check('空串 → 空串', speakable('') === '')
  check('只有空白 → 空串', speakable('  ' + nl + ' ') === '')
  check('不是字符串 → 空串', speakable(null) === '')
}

console.log('3) 太长就截，而且不切在词中间')
{
  const long = '这是一段很长的话，'.repeat(30)
  const said = speakable(long, 40)
  check('截到上限以内', said.length <= 40, String(said.length))
  // 从截断处往前找标点，别把词切一半。
  check('切在标点上', said.endsWith('，') === false && long.startsWith(said), said)
  check('刚好不超就不截', speakable('十个字十个字十个字', 20) === '十个字十个字十个字')

  // 没有标点可切的时候只能硬切，但仍然不能超。
  const noPunct = '啊'.repeat(200)
  check('无标点也守住上限', speakable(noPunct, 30).length === 30, String(speakable(noPunct, 30).length))
}

console.log('4) 真的开口')
{
  /** speechSynthesis 的替身。 */
  const makeSynth = (voices) => {
    const spoken = []
    let cancels = 0
    return {
      spoken,
      get cancels() { return cancels },
      synth: { getVoices: () => voices, cancel: () => { cancels++ }, speak: (u) => spoken.push(u) },
    }
  }
  class FakeUtterance {
    constructor(text) { this.text = text }
  }

  const s = makeSynth(WINDOWS)
  const ok = speak({ synth: s.synth, Utterance: FakeUtterance }, '搞定啦~', { rate: 1.2, volume: 0.5 })
  check('返回 true', ok === true)
  check('说了一条', s.spoken.length === 1)
  check('文本清理过', s.spoken[0].text === '搞定啦', s.spoken[0].text)
  check('用了 Yaoyao', String(s.spoken[0].voice.name).includes('Yaoyao'))
  check('lang 跟着音色走', s.spoken[0].lang === 'zh-CN')
  check('语速传对', s.spoken[0].rate === 1.2, String(s.spoken[0].rate))
  check('音量传对', s.spoken[0].volume === 0.5, String(s.spoken[0].volume))
  // 提醒的价值在于当下这一条：上一条还没念完就该让位，排队会让它在念五分钟前的事。
  check('先取消上一条', s.cancels === 1, String(s.cancels))

  const clamped = makeSynth(WINDOWS)
  speak({ synth: clamped.synth, Utterance: FakeUtterance }, '喂', { rate: 99, volume: 99 })
  check('语速夹在合法范围', clamped.spoken[0].rate === 2, String(clamped.spoken[0].rate))
  check('音量夹在合法范围', clamped.spoken[0].volume === 1, String(clamped.spoken[0].volume))

  const silent = makeSynth([{ name: 'Zira', lang: 'en-US' }])
  check('没有中文音色就不出声', speak({ synth: silent.synth, Utterance: FakeUtterance }, '喂') === false)
  check('而且一句也没说', silent.spoken.length === 0)

  const empty = makeSynth(WINDOWS)
  check('没什么可念的就不出声', speak({ synth: empty.synth, Utterance: FakeUtterance }, '  ') === false)
  check('没有 synth 也不炸', speak({ synth: null, Utterance: FakeUtterance }, '喂') === false)
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
