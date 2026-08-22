/**
 * The scheme toggle: system, light, dark.
 *
 * The only component on the page that holds UI state, and it holds none — the
 * choice lives in {@link module:theme-store}, outside React, so pressing this
 * re-renders this and nothing else. That is the same rule the log obeys, for
 * the same reason.
 *
 * @module
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { getThemeChoice, setThemeChoice, subscribeToTheme, THEME_CHOICES } from './theme-store.ts'
import type { ThemeChoice } from './theme-store.ts'

const LABELS: Record<ThemeChoice, string> = {
  system: 'auto',
  light: 'light',
  dark: 'dark',
}

/**
 * A radio group over the three choices.
 *
 * Radios rather than a button that cycles: the current scheme is announced,
 * every option is one keystroke away, and nobody has to press a control twice
 * to find out what it does.
 *
 * @returns the toggle element.
 */
export function ThemeToggle(): ReactNode {
  const choice = useSyncExternalStore(subscribeToTheme, getThemeChoice, getServerChoice)

  return (
    <fieldset className="theme-toggle">
      <legend className="theme-toggle-legend">Colour scheme</legend>
      {THEME_CHOICES.map((value) => (
        <label className="theme-choice" key={value}>
          <input
            type="radio"
            name="colour-scheme"
            value={value}
            checked={choice === value}
            onChange={() => {
              setThemeChoice(value)
            }}
          />
          <span>{LABELS[value]}</span>
        </label>
      ))}
    </fieldset>
  )
}

/**
 * What the toggle shows before the browser has been asked.
 *
 * @returns `system`, because that is what a page with no stored preference is
 *   doing — the stylesheet follows the operating system on its own.
 */
function getServerChoice(): ThemeChoice {
  return 'system'
}
