/**
 * Three columns, three scrollbars.
 *
 * jsdom has no layout engine, so the DOM cannot be asked how tall anything is.
 * What it can be asked is which element is meant to scroll, and the stylesheet
 * can be read for the declarations that make it one — the same tactic
 * `contrast.test.ts` uses on the palette, and for the same reason: the rule
 * that matters is easy to delete by accident and impossible to notice until
 * somebody scrolls.
 *
 * The failure being guarded against is specific. A grid item's `min-height` is
 * `auto`, so a column full of events grows taller than its row instead of
 * scrolling inside it — and every column moves together on one page
 * scrollbar, which is exactly what makes an inspector useless: the point of
 * three columns is reading one against another.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mountInspector } from './helpers/inspector.tsx'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '../src/styles/inspector.css'), 'utf8')

/**
 * The declarations of one rule.
 *
 * @param selector - the selector, matched literally.
 * @returns property/value pairs, with comments stripped.
 */
function rule(selector: string): Record<string, string> {
  const body = new RegExp(`(?:^|\\})[^{}]*?${escape(selector)}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  )?.[1]
  if (body === undefined) throw new Error(`no rule for ${selector}`)
  return Object.fromEntries(
    body
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== ''),
  )
}

function escape(selector: string): string {
  return selector.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

describe('the page', () => {
  it('does not scroll', () => {
    // Every scrollbar on screen belongs to a column.
    expect(rule('#root')['overflow']).toBe('hidden')
  })
})

describe('each column', () => {
  it('has a body of its own to scroll', () => {
    const view = mountInspector()

    const bodies = [...view.container.querySelectorAll('.panel')].map((panel) =>
      panel.querySelector('.panel-body'),
    )

    expect(bodies).toHaveLength(3)
    expect(bodies.every((body) => body !== null)).toBe(true)
  })

  it('scrolls in its body rather than growing', () => {
    expect(rule('.panel-body')['overflow-y']).toBe('auto')
    expect(rule('.panel-body')['min-height']).toBe('0')
  })

  it('is held to the height of its row', () => {
    // Both halves are needed: `min-height` lets the panel be shorter than its
    // content, `overflow` keeps anything that still escapes from painting over
    // the column next door.
    expect(rule('.panel')['min-height']).toBe('0')
    expect(rule('.panel')['overflow']).toBe('hidden')
  })

  it('sits in a row that cannot be stretched by the tallest of them', () => {
    expect(rule('.inspector-columns')['grid-template-rows']).toBe('minmax(0, 1fr)')
    expect(rule('.inspector-columns')['min-height']).toBe('0')
  })

  it('keeps a wheel that reaches the end to itself', () => {
    expect(rule('.panel-body')['overscroll-behavior']).toBe('contain')
  })
})
