/**
 * Wallpaper library for the conversation backdrop: pick an image off disk, keep
 * a few, switch between them.
 *
 * This replaced a custom-colour swatch. A flat colour behind the transcript was
 * the least interesting thing that slot could hold — the five gradients already
 * cover "I want some colour there", and a sixth shade of the same idea is not a
 * personalisation feature. An image is.
 *
 * The bytes never touch the settings document. The shell stores them under
 * `~/.dsh/wallpapers` and serves them from `/__wallpaper`; settings keep only
 * `wallpaper:<id>`. Putting the image in settings would be less code and would
 * drag a few hundred KB of base64 through every `settings.describe` — including
 * the ones the desktop shell itself makes on a timer.
 *
 * Desktop-only, and it says so by disappearing: in a browser the route falls
 * through to the Host and 404s, so a failed listing hides the whole block
 * rather than offering a button that cannot work.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ThemeKey } from './locales.ts'
import { WALLPAPER_PREFIX, WALLPAPER_ROUTE, wallpaperId } from './palettes.ts'
import css from './AppearanceRow.module.css'

/** Longest edge of the stored image. Beyond this a backdrop gains nothing. */
const FULL_EDGE = 1920

/** Longest edge of the thumbnail shown in this picker. */
const THUMB_EDGE = 96

/** JPEG quality for the stored image. */
const FULL_QUALITY = 0.82

/** JPEG quality for the thumbnail. */
const THUMB_QUALITY = 0.7

/** Reject before decoding: a RAW file or a video would otherwise hang the tab. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024

/** Props: the current selection, how to change it, and the locale seat. */
export interface WallpaperPickerProps {
  /** Persisted `chatBackground` value. */
  selection: string
  /** Switch the backdrop to the given wallpaper (or away from a deleted one). */
  onSelect: (value: string) => void
  /** Locale lookup shared with the row. */
  t: (key: ThemeKey) => string
}

/**
 * Re-encode one picked file into a stored image plus a thumbnail.
 *
 * Downscaling happens here rather than in the shell so the shell needs no image
 * library at all — the renderer already has a full graphics stack, and shipping
 * a native codec into an Electron main process to do what canvas does for free
 * is a poor trade.
 *
 * Flattened onto white: JPEG has no alpha, and an unfilled canvas exports
 * transparent pixels as black. A PNG logo with a clear background would arrive
 * as a black slab, which reads as a broken file rather than a design choice.
 *
 * @param file - the user's pick.
 * @returns both encodings as `data:` URIs.
 */
async function encode(file: File): Promise<{ full: string; thumb: string }> {
  const bitmap = await createImageBitmap(file)
  try {
    const draw = (edge: number, quality: number): string => {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('canvas 2d unavailable')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      return canvas.toDataURL('image/jpeg', quality)
    }
    return { full: draw(FULL_EDGE, FULL_QUALITY), thumb: draw(THUMB_EDGE, THUMB_QUALITY) }
  } finally {
    // Bitmaps hold decoded pixels outside the JS heap; GC will not hurry.
    bitmap.close()
  }
}

/**
 * Render the wallpaper library.
 * @param props - selection, writer, and locale seat.
 * @returns the picker element tree, or null where the shell route is absent.
 */
export function WallpaperPicker({ selection, onSelect, t }: WallpaperPickerProps) {
  /** Stored ids, newest first. `null` until the first listing settles. */
  const [items, setItems] = useState<readonly string[] | null>(null)
  /** False once the route proves absent — a browser, or an older shell. */
  const [supported, setSupported] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (): Promise<readonly string[]> => {
    const response = await fetch(WALLPAPER_ROUTE, { method: 'GET' })
    if (!response.ok) throw new Error(String(response.status))
    const body = await response.json() as { items?: unknown }
    const list = Array.isArray(body.items) ? body.items.filter((x): x is string => typeof x === 'string') : []
    setItems(list)
    return list
  }, [])

  useEffect(() => {
    let cancelled = false
    void refresh().catch(() => { if (!cancelled) setSupported(false) })
    return () => { cancelled = true }
  }, [refresh])

  const current = wallpaperId(selection)

  const onPick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setError('')
    if (file.size > MAX_SOURCE_BYTES) { setError(t('chat.tooBig')); return }
    setBusy(true)
    try {
      const encoded = await encode(file).catch(() => undefined)
      if (encoded === undefined) { setError(t('chat.badImage')); return }
      const response = await fetch(WALLPAPER_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encoded),
      })
      if (!response.ok) { setError(t('chat.saveFailed')); return }
      const { id } = await response.json() as { id?: string }
      if (typeof id !== 'string') { setError(t('chat.saveFailed')); return }
      await refresh()
      // Selecting the new one is the whole point of having added it.
      onSelect(WALLPAPER_PREFIX + id)
    } finally {
      setBusy(false)
      // Clear the input so picking the same file twice still fires a change.
      if (fileRef.current !== null) fileRef.current.value = ''
    }
  }

  const onRemove = async (id: string): Promise<void> => {
    setError('')
    await fetch(`${WALLPAPER_ROUTE}/${id}`, { method: 'DELETE' }).catch(() => undefined)
    const left = await refresh().catch(() => [] as readonly string[])
    // Dropping the one in use would otherwise leave the backdrop pointing at a
    // 404 — visually identical to "no backdrop", but with the row still showing
    // it as selected.
    if (current === id) onSelect(left[0] === undefined ? 'none' : WALLPAPER_PREFIX + left[0])
  }

  if (!supported) return null

  return (
    <>
      <div className={css.subTitle}>{t('chat.wallpaper')}</div>
      <div className={css.controlRow}>
        {(items ?? []).map(id => (
          <span
            key={id}
            className={clsx(css.wallTile, current === id && css.wallTileSelected)}
          >
            <button
              type="button"
              className={css.wallPick}
              aria-label={t('chat.wallpaper')}
              aria-pressed={current === id}
              style={{ backgroundImage: `url('${WALLPAPER_ROUTE}/${id}/thumb')` }}
              onClick={() => { onSelect(WALLPAPER_PREFIX + id) }}
            />
            <button
              type="button"
              className={css.wallRemove}
              title={t('chat.remove')}
              aria-label={t('chat.remove')}
              onClick={() => { void onRemove(id) }}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className={css.ghostButton}
          disabled={busy}
          onClick={() => { fileRef.current?.click() }}
        >
          {busy ? t('chat.adding') : t('chat.add')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => { void onPick(event.target.files?.[0]) }}
        />
        {error !== '' && <span className={css.hint}>{error}</span>}
      </div>
    </>
  )
}
