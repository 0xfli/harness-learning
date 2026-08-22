/**
 * Which colour scheme the page is in.
 *
 * This is the one piece of state in `apps/web` that is not a projection of the
 * log, and it is deliberately kept out of React for the same reason the log is:
 * a value held above the panels re-renders the panels when it changes. It lives
 * in a module-level store, components subscribe to it with
 * `useSyncExternalStore`, and only the subscriber re-renders.
 *
 * The store owns one piece of DOM: `data-theme` on the root element. Nothing
 * else writes it. Note what the *stylesheet* does without any of this — the
 * palette is built from `light-dark()` under `color-scheme: light dark`, so a
 * page with JavaScript disabled still follows the operating system. The
 * attribute exists to overrule that, and to tell HeroUI's own stylesheet which
 * scheme it is in.
 *
 * @module
 */

/** What a human asked for: a scheme, or "whatever the system says". */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** What that resolves to once the system has been asked. */
export type ColourScheme = 'light' | 'dark'

/** Every choice, in the order the toggle offers them. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

const STORAGE_KEY = 'harness:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const listeners = new Set<() => void>()

let choice: ThemeChoice | undefined
let media: MediaQueryList | undefined

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark'
}

/**
 * The last choice this browser remembered.
 *
 * @returns the stored choice, or `system` when there is none. Storage can
 *   throw outright — Safari in private mode does — and a page that will not
 *   render because it could not read a preference is worse than a page that
 *   forgets one.
 */
function readStoredChoice(): ThemeChoice {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
    return isChoice(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

function writeStoredChoice(next: ThemeChoice): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next)
  } catch {
    // Preference not remembered; the page still works.
  }
}

/**
 * The system's preference right now.
 *
 * @returns `dark` when the system asks for it, `light` when it does not or
 *   cannot be asked. jsdom has no `matchMedia`, which is the usual reason.
 */
function systemScheme(): ColourScheme {
  const query = globalThis.matchMedia?.(DARK_QUERY)
  return query?.matches === true ? 'dark' : 'light'
}

/** What the human asked for. */
export function getThemeChoice(): ThemeChoice {
  choice ??= readStoredChoice()
  return choice
}

/**
 * The scheme actually in force.
 *
 * @returns the choice, or the system's preference when the choice is `system`.
 */
export function getColourScheme(): ColourScheme {
  const current = getThemeChoice()
  return current === 'system' ? systemScheme() : current
}

/**
 * Put the resolved scheme on the root element.
 *
 * Always the *resolved* scheme, never `system`: HeroUI's stylesheet keys off
 * `[data-theme='dark']`, and "follow the system" is not something a CSS
 * attribute selector can be told.
 */
function apply(): void {
  globalThis.document?.documentElement.setAttribute('data-theme', getColourScheme())
}

function emit(): void {
  // Snapshotted before dispatch: a component unsubscribing mid-dispatch must
  // not be called, and one attaching mid-dispatch starts at the next change.
  const current = [...listeners]
  for (const listener of current) {
    if (listeners.has(listener)) listener()
  }
}

/**
 * Watch the system preference, but only while somebody is listening.
 *
 * The listener is attached on the first subscribe and dropped on the last
 * unsubscribe, which keeps importing this module free of side effects — a test
 * that never renders the toggle never touches the document.
 */
function startWatching(): void {
  if (media !== undefined) return
  media = globalThis.matchMedia?.(DARK_QUERY)
  media?.addEventListener('change', onSystemChange)
}

function stopWatching(): void {
  media?.removeEventListener('change', onSystemChange)
  media = undefined
}

function onSystemChange(): void {
  // Only `system` defers to the system; an explicit choice outranks it.
  if (getThemeChoice() !== 'system') return
  apply()
  emit()
}

/**
 * Choose a scheme.
 *
 * @param next - the new choice. Remembered, applied to the document, and
 *   broadcast — in that order, so a subscriber that reads the document sees
 *   the change that woke it.
 */
export function setThemeChoice(next: ThemeChoice): void {
  if (!isChoice(next)) throw new TypeError(`unknown theme choice: ${String(next)}`)
  if (getThemeChoice() === next) return
  choice = next
  writeStoredChoice(next)
  apply()
  emit()
}

/**
 * Subscribe to the choice.
 *
 * @param listener - called after every change.
 * @returns a function that detaches it.
 */
export function subscribeToTheme(listener: () => void): () => void {
  if (listeners.size === 0) {
    startWatching()
    // The document may not carry the attribute yet — this is the first
    // moment anyone has cared what it says.
    apply()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopWatching()
  }
}

/**
 * Forget everything, for a test that needs a fresh store.
 *
 * Exported because the store is module-level and Vitest modules are shared
 * within a file; without this, one test's choice is the next test's default.
 */
export function resetThemeStore(): void {
  stopWatching()
  listeners.clear()
  choice = undefined
  globalThis.document?.documentElement.removeAttribute('data-theme')
}
