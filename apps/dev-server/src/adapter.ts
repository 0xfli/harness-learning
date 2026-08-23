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
import type { ModelAdapter, ReasoningEffort } from '@harness/llm'

/** The variables that pick and configure an adapter. */
export interface AdapterEnv {
  /** Bearer token. Its presence is what switches the provider on. */
  readonly HARNESS_API_KEY?: string | undefined
  /** Model id. Required when a key is set. */
  readonly HARNESS_MODEL?: string | undefined
  /** API root for an OpenAI-compatible provider. */
  readonly HARNESS_BASE_URL?: string | undefined
  /** How hard the model should think: `minimal`, `low`, `medium` or `high`. */
  readonly HARNESS_REASONING?: string | undefined
  /** Whether the model should reason at all: `enabled` or `disabled`. */
  readonly HARNESS_THINKING?: string | undefined
  /** Milliseconds between scripted deltas. */
  readonly HARNESS_SCRIPT_DELAY_MS?: string | undefined
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
    const reasoning = reasoningFromEnv(env.HARNESS_REASONING)
    const thinking = thinkingFromEnv(env.HARNESS_THINKING)
    return createOpenAiAdapter({
      model,
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(thinking === undefined ? {} : { thinking }),
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

/**
 * The efforts some provider will accept, which is not "any string" — but is
 * also not what any one provider accepts. See {@link ReasoningEffort}.
 */
const EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * Read `HARNESS_REASONING`, refusing a value no provider would accept.
 *
 * Rejecting loudly rather than passing it through, because the alternative is
 * a 400 from the provider on the first message of the session, blamed on the
 * request rather than on the typo in `.env` that caused it. A value that is
 * spelled right but wrong for *this* provider still reaches the provider, and
 * that is the right division of labour: only it knows what it takes.
 *
 * @param value - the raw variable.
 * @returns the effort, or `undefined` when unset.
 * @throws when set to something that is not an effort.
 */
function reasoningFromEnv(value: string | undefined): ReasoningEffort | undefined {
  const trimmed = nonEmpty(value)
  if (trimmed === undefined) return undefined
  const effort = EFFORTS.find((candidate) => candidate === trimmed)
  if (effort === undefined) {
    throw new Error(`HARNESS_REASONING must be one of ${EFFORTS.join(', ')}; got ${trimmed}`)
  }
  return effort
}

/**
 * Read `HARNESS_THINKING`, which is a switch rather than a dial.
 *
 * @param value - the raw variable.
 * @returns `enabled`, `disabled`, or `undefined` to let the model decide.
 * @throws when set to anything else.
 */
function thinkingFromEnv(value: string | undefined): 'enabled' | 'disabled' | undefined {
  const trimmed = nonEmpty(value)
  if (trimmed === undefined) return undefined
  if (trimmed === 'enabled' || trimmed === 'disabled') return trimmed
  throw new Error(`HARNESS_THINKING must be enabled or disabled; got ${trimmed}`)
}
