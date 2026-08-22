import { describe, expect, it } from 'vitest'
import { EVENT_COLOUR_TOKENS, eventColourToken, eventFamily } from '../src/event-colour.ts'
import { readPalette, token as themeToken } from './helpers/contrast.ts'

describe('eventFamily', () => {
  it.each([
    ['demo/hello', 'demo'],
    ['assistant/chunk', 'assistant'],
    ['tool/call/started', 'tool'],
    ['heartbeat', 'heartbeat'],
    ['/leading', ''],
  ])('reads %s as the family %s', (type, family) => {
    expect(eventFamily(type)).toBe(family)
  })
})

describe('eventColourToken', () => {
  it('paints a whole family alike', () => {
    expect(eventColourToken('assistant/chunk')).toBe(eventColourToken('assistant/message'))
    expect(eventColourToken('user/message')).not.toBe(eventColourToken('assistant/message'))
  })

  it.each([
    ['demo/hello', '--type-demo'],
    ['session/started', '--type-session'],
    ['user/message', '--type-user'],
    ['assistant/chunk', '--type-assistant'],
    ['tool/call', '--type-tool'],
    ['error/unhandled', '--type-error'],
  ])('gives %s its own name', (type, token) => {
    expect(eventColourToken(type)).toBe(token)
  })

  it('is stable for a family it has never met', () => {
    const first = eventColourToken('plugin/loaded')

    expect(eventColourToken('plugin/loaded')).toBe(first)
    expect(eventColourToken('plugin/failed')).toBe(first)
    expect(EVENT_COLOUR_TOKENS).toContain(first)
  })

  it('spreads unfamiliar families across the slots', () => {
    const families = ['plugin/a', 'budget/a', 'approval/a', 'sandbox/a', 'retry/a', 'summary/a']

    const used = new Set(families.map(eventColourToken))

    // Collisions are fine — running out of visual distinction quietly is not.
    expect(used.size).toBeGreaterThan(1)
  })

  it('only ever names a colour the theme defines', () => {
    // The tokens still live in `theme.css`, but they are `light-dark()` pairs
    // now, so a substring check is no longer enough — a token could name the
    // right variable and still be unpaintable. `readPalette` parses the file
    // and resolves each one, and throws on anything it cannot measure, so this
    // fails both for a token the theme forgot and for one it wrote wrongly.
    for (const scheme of ['light', 'dark'] as const) {
      const palette = readPalette(scheme)

      for (const name of EVENT_COLOUR_TOKENS) {
        expect(() => themeToken(palette, name.replace(/^--/, ''))).not.toThrow()
      }
    }
  })
})
