import { describe, expect, it } from 'vitest'
import { describeProxy, proxyFetchFromEnv, proxySettings } from '../src/proxy.ts'

describe('proxySettings', () => {
  it('reads the lowercase spelling', () => {
    expect(
      proxySettings({
        http_proxy: 'http://proxy:8080',
        https_proxy: 'http://proxy:8443',
        no_proxy: 'localhost',
      }),
    ).toEqual({
      httpProxy: 'http://proxy:8080',
      httpsProxy: 'http://proxy:8443',
      noProxy: 'localhost',
    })
  })

  it('falls back to the uppercase spelling', () => {
    expect(
      proxySettings({
        HTTP_PROXY: 'http://proxy:8080',
        HTTPS_PROXY: 'http://proxy:8443',
        NO_PROXY: 'localhost',
      }),
    ).toEqual({
      httpProxy: 'http://proxy:8080',
      httpsProxy: 'http://proxy:8443',
      noProxy: 'localhost',
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
    expect(proxySettings({ http_proxy: value, https_proxy: value })).toEqual({
      httpProxy: undefined,
      httpsProxy: undefined,
      noProxy: undefined,
    })
  })

  it('reports nothing on a machine with a direct connection', () => {
    expect(proxySettings({})).toEqual({
      httpProxy: undefined,
      httpsProxy: undefined,
      noProxy: undefined,
    })
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
})

describe('describeProxy', () => {
  it('names the https proxy, which is the one a provider call uses', () => {
    expect(
      describeProxy({
        httpProxy: 'http://plain:8080',
        httpsProxy: 'http://secure:8443',
        noProxy: undefined,
      }),
    ).toBe('http://secure:8443')
  })

  it('falls back to the http proxy when that is all there is', () => {
    expect(
      describeProxy({ httpProxy: 'http://plain:8080', httpsProxy: undefined, noProxy: undefined }),
    ).toBe('http://plain:8080')
  })

  it('drops credentials, which a banner is the last place for', () => {
    expect(
      describeProxy({
        httpProxy: undefined,
        httpsProxy: 'http://user:hunter2@secure:8443/',
        noProxy: undefined,
      }),
    ).toBe('http://secure:8443')
  })

  it('says nothing when there is no proxy', () => {
    expect(
      describeProxy({ httpProxy: undefined, httpsProxy: undefined, noProxy: undefined }),
    ).toBeUndefined()
  })

  it('passes through something that is not a url rather than throwing', () => {
    expect(
      describeProxy({ httpProxy: undefined, httpsProxy: 'not a url', noProxy: undefined }),
    ).toBe('not a url')
  })
})
