/**
 * Choosing a model at boot.
 *
 * The default is the scripted adapter, and that is a feature: `pnpm run dev`
 * streams a reply with no key, no network and no account, so the thing this
 * step is actually about — every delta becoming an event — is visible to
 * anyone who clones the repo. Set the environment and the same code path talks
 * to a real provider instead.
 *
 * @module
 */

import { createOpenAiAdapter, createScriptedAdapter } from '@harness/llm'
import type { ModelAdapter } from '@harness/llm'
import { proxyFetchFromEnv } from './proxy.ts'

/** The variables that pick and configure an adapter. */
export interface AdapterEnv {
  /** Bearer token. Its presence is what switches the provider on. */
  readonly HARNESS_API_KEY?: string | undefined
  /** Model id. Required when a key is set. */
  readonly HARNESS_MODEL?: string | undefined
  /** API root for an OpenAI-compatible provider. */
  readonly HARNESS_BASE_URL?: string | undefined
  /** Milliseconds between scripted deltas. */
  readonly HARNESS_SCRIPT_DELAY_MS?: string | undefined
  /** Standard proxy variables, read by {@link proxyFetchFromEnv}. */
  readonly http_proxy?: string | undefined
  readonly HTTP_PROXY?: string | undefined
  readonly https_proxy?: string | undefined
  readonly HTTPS_PROXY?: string | undefined
  readonly no_proxy?: string | undefined
  readonly NO_PROXY?: string | undefined
}

/** Slow enough to watch arrive, fast enough not to be annoying. */
const DEFAULT_SCRIPT_DELAY_MS = 40

/**
 * Build the adapter the server should use.
 *
 * @param env - the process environment, or a stand-in.
 * @returns a configured adapter; scripted unless a key says otherwise.
 * @throws when a key is set without a model, which is a misconfiguration
 *   rather than a reason to silently fall back to the fake.
 */
export function adapterFromEnv(env: AdapterEnv = process.env): ModelAdapter {
  const apiKey = nonEmpty(env.HARNESS_API_KEY)

  if (apiKey !== undefined) {
    const model = nonEmpty(env.HARNESS_MODEL)
    if (model === undefined) {
      throw new Error('HARNESS_API_KEY is set but HARNESS_MODEL is not; refusing to guess a model')
    }
    const baseUrl = nonEmpty(env.HARNESS_BASE_URL)
    // Only when the machine actually has a proxy configured; otherwise the
    // adapter keeps the runtime's own `fetch`.
    const proxied = proxyFetchFromEnv(env)
    return createOpenAiAdapter({
      model,
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(proxied === undefined ? {} : { fetch: proxied }),
    })
  }

  const configured = Number(env.HARNESS_SCRIPT_DELAY_MS)
  const delayMs =
    Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SCRIPT_DELAY_MS
  return createScriptedAdapter({ delayMs })
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}
