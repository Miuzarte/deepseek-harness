/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'
import { localDragResource } from './file-drag.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'

/** Launch parameters read before the profile boots; `DSH_*` cannot live in `.env`. */
interface DesktopPreferences {
  /** Listen address for the Host's web server. */
  bind?: string
  /** Listen port for the Host's web server. */
  port?: number
}

/**
 * Read `desktop.yml` beside the Harness home's `.env`. The harness refuses
 * `DSH_*` names in `.env`, and these two choose the listener the shell boots, so
 * they need a file the launcher reads before any profile is composed. A missing
 * file means "launch with the defaults"; a malformed one fails the launch loudly
 * rather than silently falling back to loopback.
 * @returns the declared bind address and port, each absent when undeclared.
 */
function readDesktopPreferences(): DesktopPreferences {
  const path = join(resolveDshHome(), 'desktop.yml')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {}
    throw new Error(`desktop host: failed to read ${path}: ${String(error)}`)
  }
  const parsed: unknown = text.trim() === '' ? null : parseYaml(text)
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`desktop host: ${path} must be a mapping with optional "bind" and "port"`)
  }
  const record = parsed as Record<string, unknown>
  const unsupported = Object.keys(record).filter(key => key !== 'bind' && key !== 'port')
  if (unsupported.length > 0) throw new Error(`desktop host: ${path} has unsupported keys: ${unsupported.join(', ')}`)
  const { bind, port } = record
  if (bind !== undefined && (typeof bind !== 'string' || bind.length === 0)) {
    throw new Error(`desktop host: ${path} "bind" must be a non-empty address literal`)
  }
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new Error(`desktop host: ${path} "port" must be an integer from 0 through 65535`)
  }
  return { ...bind === undefined ? {} : { bind }, ...port === undefined ? {} : { port } }
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  // One listener covers loopback, the LAN, and a VPN at once only when it binds
  // every interface: the web app then requires --allow-lan and admits each
  // non-loopback IPv4 to the browser-trust fence. A concrete interface bind has
  // no loopback route, and the shell window below is a `dsh-app://` document
  // whose API calls to a non-loopback authority are cross-origin, which the
  // fence refuses.
  const preferences = readDesktopPreferences()
  const bindHost = process.env.DSH_DESKTOP_HOST ?? preferences.bind ?? '127.0.0.1'
  const bindPort = process.env.DSH_DESKTOP_PORT ?? (preferences.port === undefined ? '0' : String(preferences.port))
  const loopbackBind = bindHost.startsWith('127.') || bindHost === 'localhost' || bindHost === '::1'
  const wildcardBind = bindHost === '0.0.0.0' || bindHost === '::'
  if (!loopbackBind && !wildcardBind) {
    throw new Error(`desktop host: DSH_DESKTOP_HOST=${bindHost} cannot serve the desktop window, whose dsh-app origin the browser-trust fence refuses on a non-loopback authority; use 0.0.0.0 to serve loopback, the LAN, and a VPN together`)
  }
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: [
      '--no-open',
      '--host', bindHost,
      '--port', bindPort,
      ...wildcardBind ? ['--allow-lan'] : [],
    ],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const dragReads = new Map<number, AbortController>()
  const dragTasks = new Set<Promise<void>>()
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    for (const abort of dragReads.values()) abort.abort()
    await Promise.allSettled(dragTasks)
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    // A handle a disposed plugin left open would otherwise keep the Host alive past the shell's graceful
    // deadline; a startup failure keeps its own diagnostic exit.
    if (running !== undefined) process.exit()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'file-drag-cancel') {
      if ('requestId' in message && typeof message.requestId === 'number') dragReads.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'file-drag-resource') {
      if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
        || !('address' in message) || typeof message.address !== 'string') return
      const { requestId, address } = message
      const abort = new AbortController()
      dragReads.set(requestId, abort)
      const task = (async () => {
        try {
          if (stopping !== undefined) throw new Error('Host stopping')
          const { ctx } = await application
          const resource = await localDragResource(ctx, address, abort.signal)
          await send({ type: 'file-drag-resource', requestId, resource })
        } catch (error) {
          if (!abort.signal.aborted) console.error(error)
          await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
        } finally { dragReads.delete(requestId) }
      })().catch((error: unknown) => { console.error(error) })
      dragTasks.add(task)
      void task.finally(() => { dragTasks.delete(task) })
      return
    }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  // The window is one frontend of this Host and stays on loopback, even when the
  // listener serves every interface: `getOrigin()` would report the wildcard
  // bind, which no client can open.
  const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections(ctx.connection.browserPeer) }, (error) => { if (error !== null) console.error(error) })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
