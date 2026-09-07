'use strict'

/**
 * 桌面陪伴助手有哪些角色，以及每个角色拿什么动画表达什么、拿什么话说什么。
 *
 * 分工是这样的：**壳只说"发生了什么"，角色自己决定"演什么、怎么说"。** 主进程发
 * 的是 `done` / `reply` / `error` 这类事实，不是 `clap` / `happy` 这类动画名。否则
 * 每加一个角色都要回头改主进程 —— 而角色的动画表本来就不一样：MIKU 有八套，庄方宜
 * 有十二套，两边连"高兴"该演什么都不同。
 *
 * `lines` 是同一条分工的另一半。壳自己也要说话（报喜、换话题、跨天忘事），那几句
 * 不经过模型，早先直接写死在主进程里 —— 于是庄方宜会用 MIKU 的腔调说"搞定啦~"，
 * 甚至自称 MIKU。气泡里分不出哪句是模型说的、哪句是壳说的，串味就串在这里。现在
 * 那几句跟着角色走。
 *
 * 于是这里是唯一一处需要改的地方：加角色 = 加一条记录 + 一份台词 + 一个素材目录。
 *
 * @module pet-characters
 */

;((root, factory) => {
  const api = factory()
  if (typeof module === 'object' && module !== null && typeof module.exports === 'object') module.exports = api
  else root.__dshCharacters = api
})(globalThis, () => {

/**
 * 底色角色：会一直循环，表示"她现在处于什么情形"。
 *
 * `held` 是被按住拖动。它是底色而不是一次性动画，因为拖多久就该演多久。
 */
const BASE_ROLES = ['idle', 'busy', 'attention', 'nap', 'held']

/**
 * 一次性角色：插播一轮就回到底色，表示"刚刚发生了一件事"。
 */
const SHOT_ROLES = ['done', 'reply', 'error', 'greet']

/**
 * 壳自己要说的那几句，按角色、按语言。
 *
 * 只有这几句：它们全都**不经过模型**，是壳按已知事实直接拼的（哪件事完了、翻篇了、
 * 会话没开起来）。要模型说的话不在这里 —— 那由人设管，在 agent 预设里。
 *
 * 带占位的写成函数而不是模板串：中文说"3 个任务"、英文说"3 tasks"，位置和量词都
 * 不一样，靠 replace 拼只会得到一句两种语言各自都不通顺的话。
 *
 * @typedef {object} Lines
 * @property {string} fresh 换了个新话题
 * @property {string} newDay 跨过一天，昨天的事忘了
 * @property {string} noSession 会话没能建起来（回给悬浮窗的错误）
 * @property {(nick: string) => string} address 称呼前缀；昵称为空时压根不调用
 * @property {string} doneOne 一件事干完了，但那句提问是空的
 * @property {(task: string) => string} doneNamed 一件事干完了，报出是哪件
 * @property {(n: number) => string} doneMany 好几件一起报
 * @property {(n: number) => string} doneRest 列不下的那些
 */
const LINES = {
  miku: {
    zh: {
      fresh: '好，换个话题',
      newDay: '新的一天啦，昨天的事 MIKU 忘光光咯',
      noSession: '没能建立 MIKU 的会话',
      address: (nick) => `${nick}，`,
      doneOne: '刚才那轮任务搞定啦~',
      doneNamed: (task) => `你的「${task}」任务搞定啦~`,
      doneMany: (n) => `你的 ${n} 个任务都搞定啦~`,
      doneRest: (n) => `还有 ${n} 件`,
    },
    en: {
      fresh: 'Fresh topic',
      newDay: 'New day~ yesterday is all gone',
      noSession: "couldn't start MIKU's session",
      address: (nick) => `${nick}, `,
      doneOne: 'that task is done~',
      doneNamed: (task) => `your task “${task}” is done~`,
      doneMany: (n) => `all ${n} of your tasks are done~`,
      doneRest: (n) => `and ${n} more`,
    },
  },

  // 同样几句话，换成她的说法：办完、搁下、另起一件。不用语气词，不用"~"。
  zhuang: {
    zh: {
      fresh: '好，另起一件',
      newDay: '新的一天，昨天的事我搁下了',
      noSession: '没能建立会话',
      address: (nick) => `${nick}，`,
      doneOne: '刚才那轮活办完了',
      doneNamed: (task) => `你的「${task}」办完了`,
      doneMany: (n) => `你的 ${n} 件事都办完了`,
      doneRest: (n) => `还有 ${n} 件`,
    },
    en: {
      fresh: 'New topic.',
      newDay: "New day. I've set yesterday aside.",
      noSession: "couldn't start the session",
      address: (nick) => `${nick}, `,
      doneOne: 'that one is done.',
      doneNamed: (task) => `your task “${task}” is done.`,
      doneMany: (n) => `all ${n} of your tasks are done.`,
      doneRest: (n) => `and ${n} more`,
    },
  },
}

/** 角色表。 */
const CHARACTERS = {
  miku: {
    id: 'miku',
    /** 设置面板里显示的名字。 */
    name: 'MIKU',
    /** 她那份人设所在的 agent 预设 id。 */
    preset: 'pet',
    dir: 'assets/miku',
    roles: {
      idle: 'idle',
      busy: 'thinking',
      attention: 'wave',
      nap: 'sleepy',
      held: 'shy',
      done: 'clap',
      reply: 'happy',
      error: 'sad',
      greet: 'wave',
    },
    lines: LINES.miku,
    // 八套动画每一套都已经派了用场，没有富余的可以拿来当闲时点缀。宁可空着，也不
    // 把某个有明确含义的动作（比如鼓掌＝别人干完活了）挪去当装饰 —— 那会让一个本
    // 来有信息量的动作变成噪音。
    flourish: [],
  },

  zhuang: {
    id: 'zhuang',
    name: '庄方宜',
    preset: 'pet-zhuang',
    dir: 'assets/zhuang',
    roles: {
      idle: 'idle',
      busy: 'thinking',
      attention: 'wave',
      nap: 'sleepy',
      // 被拎起来 —— 麒麟种的天师被人抓着晃，惊讶比害羞更像她。
      held: 'surprised',
      // 干完活是"打赢了"，不是"鼓掌"。她是管代，报捷比捧场更合身份。
      done: 'victory',
      reply: 'happy',
      error: 'sad',
      // 出场颔首而不是招手：招手留给"有事等你处理"，而颔首致意更像天师的做派。
      greet: 'nod',
    },
    lines: LINES.zhuang,
    // 三套角色专属动作放这里：闲着的时候偶尔来一下，比塞进某个固定事件更像她自己
    // 在做自己的事。雷法、青霆剑、打坐——都是她的本行。
    flourish: ['lightning', 'sword', 'meditate'],
  },
}

/** 默认角色。 */
const DEFAULT_ID = 'miku'

/**
 * 取一个角色。
 * @param {string} id 角色 id
 * @returns {object} 角色定义；认不得的 id 回落到默认角色
 */
function character(id) {
  return CHARACTERS[id] ?? CHARACTERS[DEFAULT_ID]
}

/**
 * 一个角色要加载哪些动画。
 *
 * 从 roles 与 flourish 里推出来而不是另列一张表：两张表迟早对不上，而对不上的表现
 * 是某个动作永远不出现，或者加载一张不存在的图。
 *
 * @param {object} def 角色定义
 * @returns {string[]} 去重后的动画名
 */
function animsOf(def) {
  return [...new Set([...Object.values(def.roles), ...def.flourish])]
}

/**
 * 取某个角色在某种语言下的台词。
 *
 * 收角色 **id** 而不是角色定义：调用方（主进程）手上拿着的就是设置里那个 id，而且
 * 认不得的 id 要跟画面回落到同一位 —— 画着 MIKU 却说着别人的话，比两边都错更难查。
 *
 * @param {string} id 角色 id
 * @param {boolean} zh 是否中文
 * @returns {Lines} 该角色的台词
 */
function linesOf(id, zh) {
  const def = character(id)
  return zh ? def.lines.zh : def.lines.en
}

return { CHARACTERS, DEFAULT_ID, BASE_ROLES, SHOT_ROLES, character, animsOf, linesOf }
})
