'use strict'

/**
 * 桌面伴侣有哪些角色，以及每个角色拿什么动画表达什么。
 *
 * 分工是这样的：**壳只说"发生了什么"，角色自己决定"演什么"。** 主进程发的是
 * `done` / `reply` / `error` 这类事实，不是 `clap` / `happy` 这类动画名。否则每加
 * 一个角色都要回头改主进程 —— 而角色的动画表本来就不一样：MIKU 有八套，庄方宜有
 * 十二套，两边连"高兴"该演什么都不同。
 *
 * 于是这里是唯一一处需要改的地方：加角色 = 加一条记录 + 一个素材目录。
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

return { CHARACTERS, DEFAULT_ID, BASE_ROLES, SHOT_ROLES, character, animsOf }
})
