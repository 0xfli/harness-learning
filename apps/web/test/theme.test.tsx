import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getColourScheme,
  getThemeChoice,
  resetThemeStore,
  setThemeChoice,
  subscribeToTheme,
} from '../src/theme-store.ts'
import { ThemeToggle } from '../src/theme-toggle.tsx'

/*
 * jsdom implements no `matchMedia`, which is the same hole HeroUI's own
 * `useTheme` falls into — its subscriber calls `window.matchMedia(...)`
 * unguarded. This is a stand-in that lets a test say what the system prefers.
 */
function fakeMatchMedia(prefersDark: boolean): { change(next: boolean): void } {
  let matches = prefersDark
  const listeners = new Set<() => void>()

  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return matches
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }))

  return {
    change(next: boolean) {
      matches = next
      const current = [...listeners]
      for (const listener of current) listener()
    },
  }
}

beforeEach(() => {
  globalThis.localStorage.clear()
  resetThemeStore()
})

afterEach(() => {
  resetThemeStore()
  vi.unstubAllGlobals()
})

describe('the theme store', () => {
  it('starts by following the system', () => {
    fakeMatchMedia(true)

    expect(getThemeChoice()).toBe('system')
    expect(getColourScheme()).toBe('dark')
  })

  it('resolves system to light when the system says so', () => {
    fakeMatchMedia(false)

    expect(getColourScheme()).toBe('light')
  })

  it('survives a browser with no matchMedia', () => {
    // jsdom, and any browser old enough to matter. The page must still render.
    expect(getColourScheme()).toBe('light')
  })

  it('lets a choice overrule the system', () => {
    const media = fakeMatchMedia(true)
    setThemeChoice('light')

    expect(getColourScheme()).toBe('light')

    media.change(false)

    // Still light because it was *asked* to be, not because it agreed.
    expect(getThemeChoice()).toBe('light')
    expect(getColourScheme()).toBe('light')
  })

  it('writes the resolved scheme to the document, never the intent', () => {
    fakeMatchMedia(true)
    const listener = vi.fn<() => void>()
    subscribeToTheme(listener)

    // `data-theme='system'` would match nothing in either stylesheet.
    expect(document.documentElement.dataset['theme']).toBe('dark')

    setThemeChoice('light')

    expect(document.documentElement.dataset['theme']).toBe('light')
  })

  it('follows the system when the system changes its mind', () => {
    const media = fakeMatchMedia(false)
    const listener = vi.fn<() => void>()
    subscribeToTheme(listener)

    media.change(true)

    expect(getColourScheme()).toBe('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores the system once a choice has been made', () => {
    const media = fakeMatchMedia(false)
    const listener = vi.fn<() => void>()
    subscribeToTheme(listener)
    setThemeChoice('light')
    listener.mockClear()

    media.change(true)

    expect(getColourScheme()).toBe('light')
    expect(listener).not.toHaveBeenCalled()
  })

  it('remembers a choice across a reload', () => {
    fakeMatchMedia(true)
    setThemeChoice('light')

    // A reload is a fresh module state over the same storage.
    resetThemeStore()

    expect(getThemeChoice()).toBe('light')
  })

  it('says nothing when nothing changed', () => {
    fakeMatchMedia(false)
    const listener = vi.fn<() => void>()
    subscribeToTheme(listener)
    setThemeChoice('dark')
    listener.mockClear()

    setThemeChoice('dark')

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops watching once the last subscriber leaves', () => {
    const media = fakeMatchMedia(false)
    const listener = vi.fn<() => void>()
    const unsubscribe = subscribeToTheme(listener)

    unsubscribe()
    media.change(true)

    expect(listener).not.toHaveBeenCalled()
  })

  it('refuses a choice it does not have', () => {
    expect(() => {
      setThemeChoice('sepia' as never)
    }).toThrow(/unknown theme choice/)
  })

  it('forgets a preference it cannot store rather than failing to render', () => {
    // Safari in private mode throws from `setItem`.
    vi.spyOn(globalThis.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    fakeMatchMedia(false)

    expect(() => {
      setThemeChoice('dark')
    }).not.toThrow()
    expect(getColourScheme()).toBe('dark')
  })
})

describe('the toggle', () => {
  const radio = (name: string): HTMLInputElement =>
    screen.getByRole('radio', { name }) as HTMLInputElement

  it('offers all three choices and marks the current one', () => {
    fakeMatchMedia(true)
    render(<ThemeToggle />)

    expect(radio('auto').checked).toBe(true)
    expect(radio('light').checked).toBe(false)
    expect(radio('dark').checked).toBe(false)
  })

  it('changes the scheme when a choice is pressed', () => {
    fakeMatchMedia(true)
    render(<ThemeToggle />)

    fireEvent.click(radio('light'))

    expect(getThemeChoice()).toBe('light')
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(radio('light').checked).toBe(true)
    expect(radio('auto').checked).toBe(false)
  })

  it('follows the system without being told', () => {
    const media = fakeMatchMedia(false)
    render(<ThemeToggle />)

    expect(document.documentElement.dataset['theme']).toBe('light')

    act(() => {
      media.change(true)
    })

    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(radio('auto').checked).toBe(true)
  })
})
