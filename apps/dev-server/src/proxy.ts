/**
 * Reaching a provider through an HTTP proxy.
 *
 * Node's `fetch` ignores `http_proxy` and friends. Every other tool on the
 * machine honours them, which makes the failure genuinely baffling: `curl`
 * reaches the provider, the browser reaches the provider, and the harness
 * reports `fetch failed` with no further opinion. On a network where DNS
 * itself lives proxy-side the request never even resolves.
 *
 * Node 24 fixes this in the runtime with `NODE_USE_ENV_PROXY`. Until the
 * engine floor moves, `undici` — the library Node's own `fetch` is built from
 * — supplies the same behaviour as a dispatcher.
 *
 * Nothing here is provider-specific, and none of it belongs in
 * `packages/core/llm`: which socket a request leaves by is deployment
 * configuration, not part of anybody's wire format. The adapter already takes
 * its `fetch` as an argument, so this is the argument.
 *
 * @module
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * The variables every proxy-aware tool has agreed on for decades.
 *
 * Both cases are read because both are in the wild. Lowercase wins, which is
 * the precedence curl settled on.
 */
export interface ProxyEnv {
  readonly http_proxy?: string | undefined
  readonly HTTP_PROXY?: string | undefined
  readonly https_proxy?: string | undefined
  readonly HTTPS_PROXY?: string | undefined
  readonly no_proxy?: string | undefined
  readonly NO_PROXY?: string | undefined
}

/** A proxy configuration, once the two spellings have been reconciled. */
export interface ProxySettings {
  readonly httpProxy: string | undefined
  readonly httpsProxy: string | undefined
  readonly noProxy: string | undefined
}

/**
 * Read the proxy variables, preferring the lowercase spelling.
 *
 * @param env - the process environment, or a stand-in.
 * @returns the reconciled settings, each field `undefined` when unset.
 */
export function proxySettings(env: ProxyEnv = process.env): ProxySettings {
  return {
    httpProxy: nonEmpty(env.http_proxy) ?? nonEmpty(env.HTTP_PROXY),
    httpsProxy: nonEmpty(env.https_proxy) ?? nonEmpty(env.HTTPS_PROXY),
    noProxy: nonEmpty(env.no_proxy) ?? nonEmpty(env.NO_PROXY),
  }
}

/**
 * A `fetch` that honours the proxy variables, when there are any.
 *
 * Returns `undefined` rather than a pass-through wrapper when no proxy is
 * configured, so a machine with a direct connection keeps using the runtime's
 * own `fetch` and never routes through undici at all. The common case is
 * unchanged, which is the point: this exists for the machines that need it and
 * is invisible on the ones that do not.
 *
 * @param env - the process environment, or a stand-in.
 * @returns a proxy-aware `fetch`, or `undefined` when none is needed.
 */
export function proxyFetchFromEnv(
  env: ProxyEnv = process.env,
): typeof globalThis.fetch | undefined {
  const settings = proxySettings(env)
  if (settings.httpProxy === undefined && settings.httpsProxy === undefined) return undefined

  // Passed explicitly rather than left to the agent's own environment read, so
  // the values in play are the ones this module resolved and nothing depends
  // on ambient state at construction time.
  const dispatcher = new EnvHttpProxyAgent({
    ...(settings.httpProxy === undefined ? {} : { httpProxy: settings.httpProxy }),
    ...(settings.httpsProxy === undefined ? {} : { httpsProxy: settings.httpsProxy }),
    ...(settings.noProxy === undefined ? {} : { noProxy: settings.noProxy }),
  })

  return ((input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as typeof globalThis.fetch
}

/**
 * How to describe the proxy in the boot banner.
 *
 * The host and port only. A proxy URL can carry credentials, and a banner is
 * the last place they should turn up.
 *
 * @param settings - the reconciled settings.
 * @returns a short description, or `undefined` when no proxy is configured.
 */
export function describeProxy(settings: ProxySettings): string | undefined {
  const url = settings.httpsProxy ?? settings.httpProxy
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    // A proxy variable that is not a URL is the user's business; undici will
    // complain about it far more precisely than a banner can.
    return url
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}
