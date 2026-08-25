'use strict'

/**
 * 系统通知：agent 需要你、或者跑完了的时候把你叫回来。
 *
 * 长任务跑起来之后人会切走做别的事，这时界面上发生什么都看不见 —— 尤其是
 * 审批请求和提问，它们**阻塞进度**，没人应答就一直卡着。这是这个模块存在的
 * 全部理由。
 *
 * 三条克制原则，否则通知会变成骚扰：
 *
 *  1. **窗口有焦点时一律不发。** 你正看着它，再弹一条是噪音。
 *  2. **"跑完了"只在确实见过它开始跑之后才发。** 连接建立时会收到一批基线
 *     状态帧，里面的 running:false 是"本来就没在跑"，不是"刚跑完"。不加这道
 *     判断，每次启动都会收到一串假的完成通知。
 *  3. **审批与提问不受第 2 条约束**，它们本身就是"需要你现在处理"。
 *
 * 宠物那条会话不算数。她不是"你的智能体"：跟桌面摆件说句话不该让托盘显示成
 * 忙碌，更不该在她答完之后弹一条"任务已完成"。少了这道过滤，问她一句"在吗"
 * 就会收到一条系统通知说你的智能体干完活了。
 *
 * 点击通知会把窗口带到前台 —— 通知的意义是让你回来，不是通报一声就完。
 *
 * @module notifications
 */

const { Notification } = require('electron')

const TEXT = {
  zh: {
    approval: { title: '需要你批准', body: (tool) => `智能体想使用 ${tool}` },
    question: { title: '智能体在问你', body: () => '有问题等待回答' },
    done: { title: '任务已完成', body: () => '智能体已结束本轮工作' },
    error: { title: '智能体出错', body: (msg) => msg },
  },
  en: {
    approval: { title: 'Approval needed', body: (tool) => `The agent wants to use ${tool}` },
    question: { title: 'The agent has a question', body: () => 'Waiting for your answer' },
    done: { title: 'Task finished', body: () => 'The agent finished this round' },
    error: { title: 'Agent error', body: (msg) => msg },
  },
}

/**
 * 建一个通知观察器。
 *
 * @param {object} deps
 * @param {() => import('electron').BrowserWindow | null} deps.getWindow 取当前窗口
 * @param {() => 'zh' | 'en'} deps.getLocale 取界面语言，通知也要跟着走
 * @param {(state: 'idle' | 'running' | 'attention') => void} [deps.onState] 状态变化（托盘与宠物用）
 * @param {(kind: string, detail?: string) => void} [deps.onSay] 同一个事件也让宠物说一句
 * @param {(sessionId: string) => boolean} [deps.isPetSession] 认出宠物自己那条会话，整条忽略
 */
function createNotifier({ getWindow, getLocale, onState, onSay, isPetSession = () => false }) {
  /**
   * 见过在跑的会话。用来把"刚跑完"与"本来就没跑"分开。
   *
   * 每个实例各一份。放模块作用域会在实例之间串味：重连后新建一个通知器，旧实例
   * 留下的会话 id 还在集合里，于是第一批基线帧的 running:false 会被当成"刚跑完"，
   * 凭空弹出一串完成通知。
   */
  const running = new Set()

  let attention = false

  const publishState = () => {
    onState?.(attention ? 'attention' : running.size > 0 ? 'running' : 'idle')
  }

  /** 窗口有焦点就不打扰 —— 你已经在看了。 */
  const focused = () => {
    const win = getWindow()
    return win !== null && !win.isDestroyed() && win.isFocused()
  }

  const notify = (kind, arg) => {
    // 宠物不受"窗口有焦点就闭嘴"的约束：人就在屏幕前时，系统通知反而容易被
    // 忽略，桌面角落有个小人开口说话是更合适的提醒方式。
    onSay?.(kind, arg)
    if (focused()) return
    if (!Notification.isSupported()) return
    const t = TEXT[getLocale()] ?? TEXT.en
    const spec = t[kind]
    const notification = new Notification({
      title: spec.title,
      body: String(spec.body(arg) ?? '').slice(0, 300),
      silent: kind === 'done',
    })
    notification.on('click', () => {
      const win = getWindow()
      if (win === null || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notification.show()
  }

  /**
   * 喂一帧（已解析的 payload）。
   *
   * 收对象而不是原始文本：同一批帧有三个旁听方，各自解析就是每帧三遍
   * JSON.parse，而流式回答一轮能有几百帧。解析和容错都归调用方一处做。
   *
   * @param {object} frame 一条下行帧的 payload
   */
  const observe = (frame) => {
    if (frame === null || typeof frame !== 'object') return
    // 下面这四类帧都带 sessionId，所以一道判断就够，不必逐个分支去挡。
    if (typeof frame.sessionId === 'string' && isPetSession(frame.sessionId)) return

    switch (frame.type) {
      case 'approval/requested':
        attention = true
        notify('approval', frame.toolName)
        break
      case 'question/requested':
        attention = true
        notify('question')
        break
      case 'approval/resolved':
      case 'question/resolved':
        attention = false
        break
      case 'host/session-status':
        if (frame.running === true) {
          running.add(frame.sessionId)
        } else if (running.delete(frame.sessionId)) {
          // delete 返回 true 才说明它确实在跑过 —— 基线帧里的 false 会返回
          // false，于是不会误报"完成"。
          notify('done')
        }
        break
      case 'host/agent-error':
        attention = true
        notify('error', frame.message)
        break
      default:
        return
    }
    publishState()
  }

  /** 窗口重新获得焦点时，"需要处理"的红点应当消掉。 */
  const clearAttention = () => {
    if (!attention) return
    attention = false
    publishState()
  }

  return { observe, clearAttention }
}

module.exports = { createNotifier }
