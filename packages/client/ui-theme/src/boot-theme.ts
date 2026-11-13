/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index render
 * embeds the deployment's durable built-in preference, font sizes, and
 * font-family lists as the fallback; the body script prefers this browser's own
 * `localStorage` override, so per-browser appearance applies before first paint.
 * Head CSS colors the document canvas before script execution; the body script
 * installs the palette selector and font variables that the client presenters
 * adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_FONT_SIZES, DEFAULT_PREFERENCE, FONT_FAMILY_FIELDS, FONT_ROLES, FONT_SIZE_SPECS, LOCAL_THEME_STORAGE_KEY,
  THEME_PREFERENCES, fontFamilyVariable, normalizeFontFamily,
  type FontFamilies, type FontSizes, type ThemePreference,
} from './theme-settings.ts'

const LIGHT_BACKGROUND = '#fff'
const DARK_BACKGROUND = '#151517'

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference): string {
  const light = `:root{color-scheme:light}body{background-color:${LIGHT_BACKGROUND};--dsh-boot-bg:${LIGHT_BACKGROUND}}`
  const dark = `:root{color-scheme:dark}body{background-color:${DARK_BACKGROUND};--dsh-boot-bg:${DARK_BACKGROUND}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/**
 * Build the body script that prefers this browser's stored override, falls
 * back per field to the embedded deployment values, and installs the palette
 * selector plus font variables.
 * @param preference - Deployment fallback built-in preference.
 * @param fontSizes - Deployment fallback font sizes in px by role.
 * @param fontFamilies - Deployment fallback font lists; each is normalized before embedding.
 * @returns the script text for one index render.
 */
function bootThemeBodyScript(preference: ThemePreference, fontSizes: FontSizes, fontFamilies: FontFamilies): string {
  const familyFields = Object.fromEntries(FONT_ROLES.map(role => [role, FONT_FAMILY_FIELDS[role]]))
  const familyVariables = Object.fromEntries(FONT_ROLES.map(role => [role, fontFamilyVariable(role)]))
  const sizeSpecs = Object.fromEntries(FONT_ROLES.map(role => [role, {
    field: FONT_SIZE_SPECS[role].field,
    variable: FONT_SIZE_SPECS[role].variable,
    min: FONT_SIZE_SPECS[role].min,
    max: FONT_SIZE_SPECS[role].max,
  }]))
  return `(() => {
  const fallbackPreference = ${JSON.stringify(preference)}
  const fallbackSizes = ${JSON.stringify(fontSizes)}
  const fallbackFamilies = ${JSON.stringify({
    text: normalizeFontFamily(fontFamilies.text),
    code: normalizeFontFamily(fontFamilies.code),
    terminal: normalizeFontFamily(fontFamilies.terminal),
  })}
  const sizeSpecs = ${JSON.stringify(sizeSpecs)}
  const familyFields = ${JSON.stringify(familyFields)}
  const familyVariables = ${JSON.stringify(familyVariables)}
  let stored
  try {
    const raw = localStorage.getItem(${JSON.stringify(LOCAL_THEME_STORAGE_KEY)})
    stored = raw === null ? undefined : JSON.parse(raw)
  } catch (_unreadable) {
    stored = undefined
  }
  const local = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  const preference = ${JSON.stringify([...THEME_PREFERENCES])}.includes(local.preference)
    ? local.preference
    : fallbackPreference
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.backgroundColor = dark ? ${JSON.stringify(DARK_BACKGROUND)} : ${JSON.stringify(LIGHT_BACKGROUND)}
  document.body.style.setProperty('--dsh-boot-bg', dark ? ${JSON.stringify(DARK_BACKGROUND)} : ${JSON.stringify(LIGHT_BACKGROUND)})
  for (const role of ${JSON.stringify([...FONT_ROLES])}) {
    const spec = sizeSpecs[role]
    const storedSize = local[spec.field]
    const px = Number.isInteger(storedSize) && storedSize >= spec.min && storedSize <= spec.max
      ? storedSize
      : fallbackSizes[role]
    document.body.style.setProperty(spec.variable, px + 'px')
    const storedFamily = local[familyFields[role]]
    const family = typeof storedFamily === 'string' ? storedFamily : fallbackFamilies[role]
    if (family !== '') document.body.style.setProperty(familyVariables[role], family)
  }
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector and font
 * size and font families before the shell mount and module script.
 * @param preference - Deployment fallback built-in preference.
 * @param fontSizes - Deployment fallback font sizes in px by role.
 * @param fontFamilies - Deployment fallback font lists; each is normalized before embedding.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSizes: FontSizes = DEFAULT_FONT_SIZES,
  fontFamilies: FontFamilies = { text: '', code: '', terminal: '' },
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSizes, fontFamilies) },
  ]
}
