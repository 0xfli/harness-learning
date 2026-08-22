import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { describeProxy, proxyFetchFromEnv, proxySettings } from '../src/proxy.ts'

describe('proxySettings', () => {
  it('reads the lowercase spelling', () => {
    expect(
      proxySettings({
        http_proxy: 'http://proxy:8080',
        https_proxy: 'http://proxy:8443',
        no_proxy: 'internal.example.com',
      }),
    ).toMatchObject({
      httpProxy: 'http://proxy:8080',
      httpsProxy: 'http://proxy:8443',
    })
  })

  it('falls back to the uppercase spelling', () => {
    expect(
      proxySettings({
        HTTP_PROXY: 'http://proxy:8080',
        HTTPS_PROXY: 'http://proxy:8443',
        NO_PROXY: 'internal.example.com',
      }),
    ).toMatchObject({
      httpProxy: 'http://proxy:8080',
      httpsProxy: 'http://proxy:8443',
    })
  })

  it('prefers lowercase when both are set, as curl does', () => {
    const settings = proxySettings({
      http_proxy: 'http://lower:8080',
      HTTP_PROXY: 'http://upper:8080',
    })

    expect(settings.httpProxy).toBe('http://lower:8080')
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats an %s value as unset', (_label, value) => {
    expect(proxySettings({ http_proxy: value, https_proxy: value })).toMatchObject({
      httpProxy: undefined,
      httpsProxy: undefined,
    })
  })

  it('reports no proxy on a machine with a direct connection', () => {
    expect(proxySettings({})).toMatchObject({ httpProxy: undefined, httpsProxy: undefined })
  })

  it.each(['localhost', '127.0.0.1', '::1'])('never proxies %s', (host) => {
    // A proxy is how a request leaves the machine; loopback does not leave it.
    expect(proxySettings({}).noProxy.split(',')).toContain(host)
    expect(proxySettings({ no_proxy: 'internal.example.com' }).noProxy.split(',')).toContain(host)
  })

  it('keeps what the environment asked for alongside loopback', () => {
    const { noProxy } = proxySettings({ no_proxy: 'internal.example.com,10.0.0.0/8' })

    expect(noProxy.split(',')).toContain('internal.example.com')
    expect(noProxy.split(',')).toContain('10.0.0.0/8')
    expect(noProxy.split(',')).toContain('localhost')
  })
})

describe('proxyFetchFromEnv', () => {
  it('stays out of the way when no proxy is configured', () => {
    // The common case: the runtime's own fetch, not a wrapper around it.
    expect(proxyFetchFromEnv({})).toBeUndefined()
  })

  it.each([
    ['http_proxy', { http_proxy: 'http://proxy:8080' }],
    ['https_proxy', { https_proxy: 'http://proxy:8443' }],
    ['HTTP_PROXY', { HTTP_PROXY: 'http://proxy:8080' }],
    ['HTTPS_PROXY', { HTTPS_PROXY: 'http://proxy:8443' }],
  ])('builds a fetch once %s is set', (_label, env) => {
    expect(typeof proxyFetchFromEnv(env)).toBe('function')
  })

  it('ignores no_proxy on its own, which configures nothing to proxy through', () => {
    expect(proxyFetchFromEnv({ no_proxy: 'localhost' })).toBeUndefined()
  })

  it('reaches a local provider directly, rather than through the proxy', async () => {
    // The bug this test exists for: a local model served on loopback —
    // `HARNESS_BASE_URL=http://127.0.0.1:11434/v1`, which openai.ts documents
    // as supported — went to the proxy and came back 502. The proxy below is
    // a closed port, so anything that consults it cannot possibly succeed.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    try {
      const proxied = proxyFetchFromEnv({
        http_proxy: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
      })
      const response = await proxied!(`http://127.0.0.1:${port}/v1/models`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('describeProxy', () => {
  it('names the https proxy, which is the one a provider call uses', () => {
    expect(
      describeProxy({
        httpProxy: 'http://plain:8080',
        httpsProxy: 'http://secure:8443',
        noProxy: '',
      }),
    ).toBe('http://secure:8443')
  })

  it('falls back to the http proxy when that is all there is', () => {
    expect(
      describeProxy({ httpProxy: 'http://plain:8080', httpsProxy: undefined, noProxy: '' }),
    ).toBe('http://plain:8080')
  })

  it('drops credentials, which a banner is the last place for', () => {
    expect(
      describeProxy({
        httpProxy: undefined,
        httpsProxy: 'http://user:hunter2@secure:8443/',
        noProxy: '',
      }),
    ).toBe('http://secure:8443')
  })

  it('says nothing when there is no proxy', () => {
    expect(
      describeProxy({ httpProxy: undefined, httpsProxy: undefined, noProxy: '' }),
    ).toBeUndefined()
  })

  it('passes through something that is not a url rather than throwing', () => {
    expect(describeProxy({ httpProxy: undefined, httpsProxy: 'not a url', noProxy: '' })).toBe(
      'not a url',
    )
  })
})
