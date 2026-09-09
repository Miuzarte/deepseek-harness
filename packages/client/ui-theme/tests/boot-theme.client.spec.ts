// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjection } from '../src/boot-theme.ts'
import { LOCAL_THEME_STORAGE_KEY, type ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(preference?: ThemePreference, fontSize?: number): void {
  const row = bootThemeInjection(preference, fontSize)
  if (row.kind !== 'script') throw new Error('theme bootstrap row is not a script')
  runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia, localStorage })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.documentElement.style.removeProperty('color-scheme')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.style.removeProperty('--dsh-content-font-size')
})

describe('theme bootstrap row', () => {
  it('is a body script row, so it runs before the shell mount', () => {
    mockSystemDark(false)
    const row = bootThemeInjection('dark')
    expect(row).toMatchObject({ kind: 'script', placement: 'body' })
    executeBootstrap('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    executeBootstrap('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, 'dark', true],
    [false, 'light', false],
  ] as const)('resolves system=%s to %s', (matches, colorScheme, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.style.colorScheme).toBe(colorScheme)
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the durable content font size and defaults it to 14px', () => {
    mockSystemDark(false)
    executeBootstrap('light', 17)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('17px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
  })

  it('prefers this browser stored override over the embedded fallback', () => {
    mockSystemDark(false)
    localStorage.setItem(LOCAL_THEME_STORAGE_KEY, JSON.stringify({ preference: 'dark', fontSize: 17 }))
    executeBootstrap('light', 12)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('17px')
  })

  it('falls back per field when the stored override carries junk', () => {
    mockSystemDark(false)
    localStorage.setItem(LOCAL_THEME_STORAGE_KEY, JSON.stringify({ preference: 'sepia', fontSize: 99 }))
    executeBootstrap('dark', 16)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
  })

  it('ignores an unreadable stored override', () => {
    mockSystemDark(false)
    localStorage.setItem(LOCAL_THEME_STORAGE_KEY, '{not json')
    executeBootstrap('light', 15)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('15px')
  })
})
