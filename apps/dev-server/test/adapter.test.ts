import { describe, expect, it } from 'vitest'
import { adapterFromEnv } from '../src/adapter.ts'

describe('adapterFromEnv', () => {
  it('defaults to the scripted adapter, so the repo runs with no key', () => {
    expect(adapterFromEnv({}).name).toBe('scripted')
  })

  it('uses a real provider once a key and a model are set', () => {
    const adapter = adapterFromEnv({
      HARNESS_API_KEY: 'secret',
      HARNESS_MODEL: 'deepseek-chat',
      HARNESS_BASE_URL: 'https://api.deepseek.com/v1',
    })

    expect(adapter.name).toBe('openai:deepseek-chat')
  })

  it('refuses a key without a model rather than guessing one', () => {
    expect(() => adapterFromEnv({ HARNESS_API_KEY: 'secret' })).toThrow(/HARNESS_MODEL/)
  })

  it.each([
    ['an empty key', { HARNESS_API_KEY: '' }],
    ['a whitespace key', { HARNESS_API_KEY: '  ' }],
    ['an unset key', { HARNESS_API_KEY: undefined }],
  ])('treats %s as no key at all', (_label, env) => {
    expect(adapterFromEnv(env).name).toBe('scripted')
  })

  it.each([
    ['not a number', 'soon'],
    ['negative', '-5'],
  ])('ignores a delay that is %s', (_label, value) => {
    // A bad delay should not stop the server booting; the default is fine.
    expect(() => adapterFromEnv({ HARNESS_SCRIPT_DELAY_MS: value })).not.toThrow()
  })
})

describe('reasoning configuration', () => {
  const provider = { HARNESS_API_KEY: 'secret', HARNESS_MODEL: 'deepseek-v4-pro' }

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts %s, because some documented provider takes it',
    (effort) => {
      expect(() => adapterFromEnv({ ...provider, HARNESS_REASONING: effort })).not.toThrow()
    },
  )

  it.each([
    ['a near miss', 'higher'],
    ['a plausible invention', 'maximum'],
    ['the wrong case', 'HIGH'],
  ])('refuses %s rather than letting the provider 400 on it', (_label, value) => {
    expect(() => adapterFromEnv({ ...provider, HARNESS_REASONING: value })).toThrow(
      /HARNESS_REASONING/,
    )
  })

  it('leaves the effort alone when unset, so the model keeps its default', () => {
    expect(() => adapterFromEnv({ ...provider })).not.toThrow()
  })

  it.each(['enabled', 'disabled'])('accepts thinking=%s', (value) => {
    expect(() => adapterFromEnv({ ...provider, HARNESS_THINKING: value })).not.toThrow()
  })

  it('refuses a thinking value that is not the switch', () => {
    expect(() => adapterFromEnv({ ...provider, HARNESS_THINKING: 'true' })).toThrow(
      /HARNESS_THINKING/,
    )
  })
})
