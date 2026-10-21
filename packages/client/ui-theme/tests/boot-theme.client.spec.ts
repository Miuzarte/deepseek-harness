// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjections } from '../src/boot-theme.ts'
import { LOCAL_THEME_STORAGE_KEY, type FontSizes, type ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(preference?: ThemePreference, fontSizes?: FontSizes): void {
  for (const row of bootThemeInjections(preference, fontSizes)) {
    if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia, localStorage })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.dsThemeSource
  document.body.removeAttribute(DARK_ATTRIBUTE)
  for (const name of ['--dsh-content-font-size', '--dsh-code-font-size', '--dsh-terminal-font-size']) document.body.style.removeProperty(name)
  for (const kind of ['text', 'code', 'terminal']) document.body.style.removeProperty(`--dsh-font-family-${kind}`)
  document.body.style.removeProperty('background-color')
  document.body.style.removeProperty('--dsh-boot-bg')
  document.body.style.removeProperty('color-scheme')
})

describe('theme bootstrap row', () => {
  it('colors the body with head CSS before applying body state', () => {
    mockSystemDark(false)
    const [head, body] = bootThemeInjections('dark')
    expect(head).toMatchObject({ kind: 'style' })
    expect(body).toMatchObject({ kind: 'script', placement: 'body' })
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    const [head] = bootThemeInjections('light')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}')
    executeBootstrap('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, true],
    [false, false],
  ] as const)('resolves system=%s for the body palette', (matches, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('uses a media query for the system canvas palette', () => {
    const [head] = bootThemeInjections('system')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(
      ':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}'
      + '@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}',
    )
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the durable font sizes and their defaults', () => {
    mockSystemDark(false)
    executeBootstrap('light', { text: 22, code: 15, terminal: 18 })
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('22px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('15px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('18px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('11px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('13px')
  })

  it('writes normalized durable font lists and leaves empty lists unset', () => {
    mockSystemDark(false)
    const [, body] = bootThemeInjections('light', undefined, { text: 'Inter', code: '', terminal: 'MesloLGS NF</script>, monospace' })
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    expect(body.text).not.toContain('</script')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia, localStorage })
    expect(document.body.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    expect(document.body.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    expect(document.body.style.getPropertyValue('--dsh-font-family-terminal')).toBe('"MesloLGS NF/script", monospace')
  })

  it('prefers this browser stored override over the embedded fallback', () => {
    mockSystemDark(false)
    localStorage.setItem(LOCAL_THEME_STORAGE_KEY, JSON.stringify({
      preference: 'dark',
      fontSize: 17,
      codeFontSize: 14,
      terminalFontFamily: 'JetBrains Mono',
    }))
    executeBootstrap('light', { text: 12, code: 10, terminal: 10 })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('17px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('14px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('10px')
    expect(document.body.style.getPropertyValue('--dsh-font-family-terminal')).toBe('JetBrains Mono')
    // The canvas follows the stored palette instead of the Host fallback.
    expect(document.body.style.backgroundColor).toBe('rgb(21, 21, 23)')
  })

  it('falls back per field when the stored override carries junk', () => {
    mockSystemDark(false)
    localStorage.setItem(LOCAL_THEME_STORAGE_KEY, JSON.stringify({
      preference: 'sepia',
      fontSize: 99,
      codeFontSize: 'large',
      terminalFontFamily: 7,
    }))
    executeBootstrap('dark', { text: 16, code: 12, terminal: 11 })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('12px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('11px')
  })

  it('ignores an unreadable stored override', () => {
    mockSystemDark(false)
    localStorage.setItem(LOCAL_THEME_STORAGE_KEY, '{not json')
    executeBootstrap('light', { text: 15, code: 11, terminal: 13 })
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('15px')
  })
})
