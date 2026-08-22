import { describe, expect, it } from 'vitest'
import { EVENT_COLOUR_TOKENS } from '../src/event-colour.ts'
import { contrast, hex, oklch, readPalette, token } from './helpers/contrast.ts'
import type { Palette, Scheme } from './helpers/contrast.ts'

/*
 * The palette, measured.
 *
 * The inspector was reported as unreadable, and measuring it showed the guess
 * was wrong: most text ratios passed and the *structure* was invisible —
 * `--surface` against `--surface-raised` at 1.07:1, `--border` at 1.28:1. Only
 * `--text-faint` actually failed, at 3.03:1, and it painted the seq and clock
 * columns of every row.
 *
 * So this file asserts both halves, in both schemes:
 *
 * - WCAG 2.2 SC 1.4.3 — 4.5:1 for text. The log rows are 12px monospace, which
 *   is nowhere near the 18.66px-bold or 24px that would make them "large".
 * - WCAG 2.2 SC 1.4.11 — 3:1 for the boundaries that carry structure. Panel
 *   edges and header rules are the only thing telling three columns apart.
 *
 * These numbers are computed, not copied. Retuning a token by eye fails here.
 */

const TEXT_AA = 4.5
const STRUCTURE_AA = 3
/** A fill step with no border to lean on has to be visible on its own. */
const FILL_STEP = 1.2

const SCHEMES: readonly Scheme[] = ['light', 'dark']

/** Every fill a piece of text can find itself on. */
const SURFACES = ['background', 'surface', 'surface-secondary', 'surface-tertiary'] as const

/** Text tokens, and the surfaces each is actually painted on. */
const TEXT: readonly { readonly name: string; readonly on: readonly string[] }[] = [
  // `body` colour, and the checked label in the toggle.
  { name: 'foreground', on: ['background', 'surface', 'surface-tertiary'] },
  // Panel titles, event types without a family colour, event data, the
  // connection status, the unchecked toggle labels.
  { name: 'muted', on: ['surface', 'surface-secondary', 'surface-tertiary'] },
  // `.panel-note`, `.panel-placeholder`, and — the reason this test exists —
  // `.event-seq` and `.event-time`, on a row that may be hovered.
  { name: 'faint', on: ['surface', 'surface-secondary', 'surface-tertiary'] },
]

function paletteFor(scheme: Scheme): Palette {
  return readPalette(scheme)
}

describe.each(SCHEMES)('the %s palette', (scheme) => {
  const palette = paletteFor(scheme)
  const ratio = (a: string, b: string): number => contrast(token(palette, a), token(palette, b))

  describe('text', () => {
    it.each(TEXT.flatMap(({ name, on }) => on.map((surface) => [name, surface] as const)))(
      '--%s reads on --%s',
      (name, surface) => {
        const measured = ratio(name, surface)
        const fg = hex(token(palette, name))
        const bg = hex(token(palette, surface))

        expect(
          measured,
          `--${name} ${fg} on --${surface} ${bg} is ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(TEXT_AA)
      },
    )
  })

  describe('the event families', () => {
    // `.event-type` is painted with the family colour, on a row that is either
    // resting on `--surface` or hovered onto `--surface-tertiary`.
    it.each(EVENT_COLOUR_TOKENS.map((t) => t.replace(/^--/, '')))(
      '--%s reads on a row, resting and hovered',
      (name) => {
        for (const surface of ['surface', 'surface-tertiary']) {
          const measured = ratio(name, surface)
          expect(
            measured,
            `--${name} ${hex(token(palette, name))} on --${surface} is ${measured.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(TEXT_AA)
        }
      },
    )

    it('gives every family a colour of its own', () => {
      const painted = EVENT_COLOUR_TOKENS.map((t) => hex(token(palette, t.replace(/^--/, ''))))

      expect(new Set(painted).size).toBe(EVENT_COLOUR_TOKENS.length)
    })
  })

  describe('structure', () => {
    // The complaint that started this: three columns and a header rule that
    // the eye could not find. A border is a boundary, so 3:1 under SC 1.4.11.
    it.each(SURFACES)('--border is visible against --%s', (surface) => {
      const measured = ratio('border', surface)
      const line = hex(token(palette, 'border'))
      const bg = hex(token(palette, surface))

      expect(
        measured,
        `--border ${line} on --${surface} ${bg} is ${measured.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(STRUCTURE_AA)
    })

    it('separates a hovered row from a resting one', () => {
      // `.event-row:hover` has no border, so the fill step is the whole signal.
      // This is the pair that used to be 1.07:1.
      const measured = ratio('surface-tertiary', 'surface')

      expect(measured, `hover step is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(FILL_STEP)
    })

    it('sets the panels apart from the page behind them', () => {
      expect(ratio('surface', 'background')).toBeGreaterThan(1.1)
    })

    it('sets a panel header apart from its body', () => {
      expect(ratio('surface-secondary', 'surface')).toBeGreaterThan(1.1)
    })

    it('keeps --separator quieter than --border', () => {
      // Otherwise there is no reason for both to exist.
      expect(ratio('separator', 'surface')).toBeLessThan(ratio('border', 'surface'))
    })
  })

  describe('feed health', () => {
    // The dots are small non-text graphics carrying the connection state, so
    // SC 1.4.11 rather than SC 1.4.3 — but they sit next to text at 4.5:1.
    it.each(['live', 'pending', 'lost', 'accent'])('--%s is visible on a panel', (name) => {
      expect(ratio(name, 'surface')).toBeGreaterThanOrEqual(STRUCTURE_AA)
    })
  })
})

describe('both schemes', () => {
  it('are actually different', () => {
    const light = paletteFor('light')
    const dark = paletteFor('dark')

    for (const [name, colour] of light) {
      // A token that forgot its second value would resolve identically in both
      // and quietly ship a one-scheme theme.
      expect(hex(colour), `--${name} is the same in both schemes`).not.toBe(hex(token(dark, name)))
    }
  })

  it('agree on which is the light one', () => {
    const light = paletteFor('light')
    const dark = paletteFor('dark')

    expect(contrast(token(light, 'surface'), [0, 0, 0])).toBeGreaterThan(
      contrast(token(dark, 'surface'), [0, 0, 0]),
    )
  })

  it('holds each family to one hue across both', () => {
    const light = paletteFor('light')
    const dark = paletteFor('dark')

    for (const name of EVENT_COLOUR_TOKENS.map((t) => t.replace(/^--/, ''))) {
      // Only lightness may move between schemes. A family that changed hue
      // would be a different colour with the same name.
      const [lr, lg, lb] = token(light, name)
      const [dr, dg, db] = token(dark, name)
      const lightOrder = channelOrder(lr, lg, lb)
      const darkOrder = channelOrder(dr, dg, db)

      expect(darkOrder, `--${name} changes hue between schemes`).toEqual(lightOrder)
    }
  })
})

describe('the measurement itself', () => {
  // A contrast helper that quietly returned the wrong number would make every
  // assertion above meaningless, so it is checked against values anyone can
  // verify by hand.
  it('agrees with the reference ratios', () => {
    expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5)
    expect(contrast([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5)
    // #767676 on white is the canonical 4.5:1 boundary.
    expect(contrast([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 1)
  })

  it('converts oklch the way a browser does', () => {
    expect(oklch(1, 0, 0)).toEqual([255, 255, 255])
    expect(oklch(0, 0, 0)).toEqual([0, 0, 0])
    // oklch(0.62796 0.25768 29.234) is sRGB red, per CSS Color 4.
    const red = oklch(0.62796, 0.25768, 29.234)
    expect(red[0]).toBeGreaterThan(250)
    expect(red[1]).toBeLessThan(5)
    expect(red[2]).toBeLessThan(5)
  })

  it('refuses a colour it cannot measure', () => {
    // The failure mode this guards against is a parser that returns black for
    // anything it does not understand, turning a broken token into a pass.
    expect(() => token(readPalette('dark'), 'not-a-token')).toThrow(/missing/)
  })
})

/** Which channel is largest, as a crude hue fingerprint. */
function channelOrder(red: number, green: number, blue: number): readonly string[] {
  return (
    [
      ['r', red],
      ['g', green],
      ['b', blue],
    ] as const
  )
    .toSorted((a, b) => b[1] - a[1])
    .map(([channel]) => channel)
}
