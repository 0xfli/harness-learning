/**
 * Measuring the palette.
 *
 * The acceptance criterion for the theme is a number, not an opinion, so this
 * is the arithmetic that produces it: parse `theme.css`, resolve each token to
 * an sRGB triple in a given scheme, and compute WCAG contrast ratios.
 *
 * Test-only, deliberately. None of this ships — it exists so that retuning a
 * colour by eye fails a test rather than a user.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A colour, as the three 8-bit channels a browser would paint. */
export type Rgb = readonly [number, number, number]

/** Which half of every `light-dark()` pair to read. */
export type Scheme = 'light' | 'dark'

/**
 * sRGB gamma decode, per WCAG 2.2 SC 1.4.3.
 *
 * @param channel - one 8-bit channel.
 * @returns its linear-light value.
 */
function toLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/**
 * sRGB gamma encode, clipping to the gamut first.
 *
 * @param value - a linear-light value, possibly outside [0, 1].
 * @returns the 8-bit channel a browser would paint.
 */
function toChannel(value: number): number {
  const clipped = Math.min(1, Math.max(0, value))
  const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/**
 * Oklch to sRGB, via Oklab and the linear-sRGB matrix.
 *
 * The matrices are Björn Ottosson's, the same ones the CSS Color 4 spec
 * carries and browsers implement — so this agrees with what is on screen.
 *
 * @param lightness - perceptual lightness, 0 to 1.
 * @param chroma - distance from grey.
 * @param hue - hue angle in degrees.
 * @returns the colour as 8-bit sRGB.
 */
export function oklch(lightness: number, chroma: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180
  const a = chroma * Math.cos(radians)
  const b = chroma * Math.sin(radians)

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    toChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

/**
 * Relative luminance, per WCAG 2.2.
 *
 * @param colour - the colour to measure.
 * @returns its relative luminance, 0 to 1.
 */
export function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue)
}

/**
 * The WCAG contrast ratio between two colours.
 *
 * @param first - one colour.
 * @param second - the other. Order does not matter.
 * @returns the ratio, between 1 and 21.
 */
export function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first)
  const b = luminance(second)
  const [lighter, darker] = a > b ? [a, b] : [b, a]
  return (lighter + 0.05) / (darker + 0.05)
}

/** Rendered as `#rrggbb`, for a failure message somebody has to read. */
export function hex([red, green, blue]: Rgb): string {
  return `#${[red, green, blue].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Split a `light-dark(a, b)` argument list on its top-level comma.
 *
 * Naive splitting is wrong the moment a value is `oklch(0.2 0.006 286)`, which
 * has no comma, or a function that does.
 *
 * @param source - the text between the outer parentheses.
 * @returns the two arguments.
 * @throws when there are not exactly two.
 */
function splitArguments(source: string): [string, string] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(source.slice(start, index))
      start = index + 1
    }
  }
  parts.push(source.slice(start))
  if (parts.length !== 2) throw new Error(`light-dark() needs two arguments, got ${parts.length}`)
  return [parts[0] as string, parts[1] as string]
}

/**
 * Parse a single colour value.
 *
 * Only the notations the theme actually uses are supported, and anything else
 * throws. A parser that silently returned black would turn a broken token into
 * a passing test, which is the one outcome this whole file exists to prevent.
 *
 * @param value - a CSS colour.
 * @returns the colour as 8-bit sRGB.
 */
function parseColour(value: string): Rgb {
  const source = value.trim()

  const oklchMatch = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(source)
  if (oklchMatch) {
    const [, lightness, chroma, hue] = oklchMatch
    const l = (lightness as string).endsWith('%')
      ? Number.parseFloat(lightness as string) / 100
      : Number.parseFloat(lightness as string)
    return oklch(l, Number.parseFloat(chroma as string), Number.parseFloat(hue as string))
  }

  const hexMatch = /^#([\da-f]{6})$/i.exec(source)
  if (hexMatch) {
    const digits = hexMatch[1] as string
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ]
  }

  throw new Error(`cannot measure the colour ${source}`)
}

/** Every colour token in `theme.css`, resolved for one scheme. */
export type Palette = ReadonlyMap<string, Rgb>

/**
 * `theme.css`, as text.
 *
 * @returns the stylesheet's source.
 */
function readTheme(): string {
  // Not `new URL('...', import.meta.url)`: Vite rewrites that into an asset
  // URL, and an asset URL is not a file on disk.
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(join(here, '../../src/styles/theme.css'), 'utf8')
}

/**
 * Two colours blended the way `color-mix(in srgb, …)` blends them.
 *
 * The inspector tints a chip with the very colour it then writes on it —
 * `color-mix(in srgb, var(--type-user) 12%, transparent)` behind text in
 * `--type-user`. That reduces the contrast the palette was measured at, by an
 * amount nobody can eyeball, so it is computed here instead.
 *
 * A translucent fill over an opaque backdrop is arithmetically the same as
 * mixing the two at the same weight, so one function covers both spellings.
 * sRGB rather than Oklab because that is the interpolation space the
 * stylesheet asks for, and the two do not agree.
 *
 * @param colour - the tint.
 * @param backdrop - what it is painted on.
 * @param weight - how much of the tint, 0 to 1.
 * @returns the colour a browser would composite.
 */
export function mix(colour: Rgb, backdrop: Rgb, weight: number): Rgb {
  return [0, 1, 2].map((channel) =>
    Math.round((colour[channel] as number) * weight + (backdrop[channel] as number) * (1 - weight)),
  ) as unknown as Rgb
}

/**
 * A percentage token, as a fraction.
 *
 * Read out of the stylesheet rather than copied into the test, so raising the
 * tint is a change the measurement sees.
 *
 * @param name - the token name, without the leading `--`.
 * @returns the value as a fraction of one.
 * @throws when the theme does not define it as a percentage.
 */
export function readPercentage(name: string): number {
  const match = new RegExp(`^\\s*--${name}:\\s*([\\d.]+)%;`, 'm').exec(readTheme())
  if (match === null) throw new Error(`theme.css is missing --${name} as a percentage`)
  return Number.parseFloat(match[1] as string) / 100
}

/**
 * Read `theme.css` and resolve its `light-dark()` tokens.
 *
 * @param scheme - which half of each pair to take.
 * @returns every token that declares a colour, by name without the leading
 *   `--`. Tokens that are not colours (`--row-height`, the fonts) are skipped;
 *   a token that *is* a colour but cannot be parsed throws.
 */
export function readPalette(scheme: Scheme): Palette {
  const css = readTheme()

  const palette = new Map<string, Rgb>()
  const declaration = /^\s*--([\w-]+):\s*light-dark\((.+)\);\s*$/gm
  for (const match of css.matchAll(declaration)) {
    const [, name, args] = match
    const [light, dark] = splitArguments(args as string)
    palette.set(name as string, parseColour(scheme === 'light' ? light : dark))
  }

  if (palette.size === 0) throw new Error('theme.css declared no light-dark() colours')
  return palette
}

/**
 * One token's colour, or a failure naming it.
 *
 * @param palette - the resolved palette.
 * @param name - the token name, without the leading `--`.
 * @returns the colour.
 * @throws when the theme does not define it. A missing token renders as
 *   nothing at all in the browser, so it must not pass here.
 */
export function token(palette: Palette, name: string): Rgb {
  const colour = palette.get(name)
  if (colour === undefined) throw new Error(`theme.css is missing --${name}`)
  return colour
}
