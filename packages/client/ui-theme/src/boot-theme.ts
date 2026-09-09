/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index render
 * embeds the deployment's durable built-in preference and content font size as
 * the fallback; the script prefers this browser's own `localStorage` override,
 * so a per-browser font size applies before first paint. The browser resolves
 * only `system`, then writes the same DOM fields ui-layout's ThemePresenter
 * owns after the client plugin tree activates.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_MAX, FONT_SIZE_MIN,
  LOCAL_THEME_STORAGE_KEY, THEME_PREFERENCES, type ThemePreference,
} from './theme-settings.ts'

/**
 * Build the inline script body: read this browser's stored override, fall back
 * to the Host-backed deployment section, and write the pre-plugin DOM fields.
 * @param preference - Deployment fallback built-in preference.
 * @param fontSize - Deployment fallback content font size in px.
 * @returns the script text for one index render.
 */
function bootThemeScript(preference: ThemePreference, fontSize: number): string {
  return `(() => {
  const fallbackPreference = ${JSON.stringify(preference)}
  const fallbackFontSize = ${JSON.stringify(fontSize)}
  let stored
  try {
    const raw = localStorage.getItem(${JSON.stringify(LOCAL_THEME_STORAGE_KEY)})
    stored = raw === null ? undefined : JSON.parse(raw)
  } catch (_unreadable) {
    stored = undefined
  }
  const usable = stored !== null && typeof stored === 'object'
  const preference = usable && ${JSON.stringify([...THEME_PREFERENCES])}.includes(stored.preference)
    ? stored.preference
    : fallbackPreference
  const fontSize = usable && Number.isInteger(stored.fontSize)
    && stored.fontSize >= ${String(FONT_SIZE_MIN)} && stored.fontSize <= ${String(FONT_SIZE_MAX)}
    ? stored.fontSize
    : fallbackFontSize
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', fontSize + 'px')
})()`
}

/**
 * The theme bootstrap as an injection row: an inline script immediately after
 * the opening body tag, before the shell mount and module script.
 * @param preference - Deployment fallback built-in preference.
 * @param fontSize - Deployment fallback content font size in px.
 * @returns the body script row.
 */
export function bootThemeInjection(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
): IndexInjection {
  return { kind: 'script', placement: 'body', text: bootThemeScript(preference, fontSize) }
}
