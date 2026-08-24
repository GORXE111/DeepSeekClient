import type { Context } from '@deepseek-ai/cordis'
import base from '../styles/base.css?inline'
import designPlatform from '../styles/design-platform.css?inline'
import scrollbar from '../styles/scrollbar.css?inline'
import gradientShadowText from '../styles/gradient-shadow-text.css?inline'
import shiki from '../styles/shiki.css?inline'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'

const STYLES = [
  ['base.css', base],
  ['design-platform.css', designPlatform],
  ['scrollbar.css', scrollbar],
  ['gradient-shadow-text.css', gradientShadowText],
  ['shiki.css', shiki],
] as const

/**
 * Mount the global theme sheets for exactly the owning plugin lifetime.
 * @param ctx - Owning plugin context.
 */
export function installThemeStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  for (const [name, css] of STYLES) {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }, `ui-theme: ${name} stylesheet`)
  }
}

/**
 * Mount the conversation-backdrop sheet and return its writer.
 *
 * A single long-lived tag whose text is rewritten, rather than a tag per
 * selection: the backdrop changes while the user drags a strength slider, and
 * swapping elements on every frame makes the browser drop and re-decode the
 * background instead of just repainting it.
 *
 * @param ctx - Owning plugin context.
 * @returns a setter taking the sheet text; an empty string clears the backdrop.
 */
export function installBackdrop(ctx: Context): (css: string) => void {
  if (typeof document === 'undefined') return () => {}
  let live: HTMLStyleElement | undefined
  let pending = ''
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/conversation-backdrop`
    // Adopt whatever was set before the effect ran, so a selection restored
    // from settings during plugin start is not silently dropped.
    tag.textContent = pending
    document.head.appendChild(tag)
    live = tag
    return () => { live = undefined; tag.remove() }
  }, 'ui-theme: conversation backdrop stylesheet')
  return (css) => {
    pending = css
    if (live !== undefined) live.textContent = css
  }
}
