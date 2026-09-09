/**
 * Persistence choice for a page served from a declared non-loopback authority:
 * Connection publishes the fact, and the mirror reads Host settings for it.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'

function bench() {
  const describeCall = vi.fn().mockResolvedValue({
    ok: true, value: { writable: true, hasDocument: true, namespaces: [] },
  })
  const ctx = new Context()
  const remote = new TestRemote(ctx, { settings: { describe: describeCall } })
  remote.$host = { home: undefined, isLoopback: false }
  return { describeCall, fiber: ctx.plugin({ inject: [...inject], apply }) }
}

afterEach(() => { Reflect.deleteProperty(globalThis, '__DSH_CONNECTION_SERVES_REMOTE__') })

describe('declared remote authority persistence', () => {
  it('reads Host settings off-loopback when Connection published the flag', async () => {
    Reflect.set(globalThis, '__DSH_CONNECTION_SERVES_REMOTE__', true)
    const { describeCall, fiber } = bench()
    await fiber.await()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })
  })

  it('stays process-local off-loopback without the flag', async () => {
    const { describeCall, fiber } = bench()
    await fiber.await()
    await Promise.resolve()
    expect(describeCall).not.toHaveBeenCalled()
  })
})
