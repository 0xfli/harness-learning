/**
 * Giving an event type a colour.
 *
 * Event types are namespaced — `demo/hello`, `user/message`,
 * `assistant/chunk` — and the namespace is the part a reader scans for. So
 * the colour is chosen per *family*, not per type: every `assistant/*` event
 * looks alike, and a new type in a known family needs no code change at all.
 *
 * Families the harness has not met yet still have to be legible, so an unknown
 * family is hashed onto a small ring of neutral slots. Deterministic, because
 * a colour that changes between reloads is worse than no colour.
 *
 * @module
 */

/** The theme tokens a row may be painted with. */
const KNOWN_FAMILIES: Readonly<Record<string, string>> = {
  demo: '--type-demo',
  session: '--type-session',
  user: '--type-user',
  assistant: '--type-assistant',
  tool: '--type-tool',
  error: '--type-error',
}

/** Where an unfamiliar family lands. Neutral hues, distinct from each other. */
const SLOTS = ['--type-slot-a', '--type-slot-b', '--type-slot-c', '--type-slot-d'] as const

/**
 * Every token {@link eventColourToken} can return.
 *
 * A colour the stylesheet does not define renders as nothing at all, so the
 * list is exported and checked against `theme.css` by a test.
 */
export const EVENT_COLOUR_TOKENS: readonly string[] = [
  ...new Set([...Object.values(KNOWN_FAMILIES), ...SLOTS]),
]

/**
 * The family an event type belongs to.
 *
 * @param type - the event type, e.g. `assistant/chunk`.
 * @returns the namespace before the first `/`, or the whole type when it has
 *   no namespace.
 */
export function eventFamily(type: string): string {
  const separator = type.indexOf('/')
  return separator === -1 ? type : type.slice(0, separator)
}

/**
 * The theme token an event should be painted with.
 *
 * @param type - the event type.
 * @returns a CSS custom property name, always one that `theme.css` defines.
 */
export function eventColourToken(type: string): string {
  const family = eventFamily(type)
  const known = KNOWN_FAMILIES[family]
  if (known !== undefined) return known
  const slot = SLOTS[hash(family) % SLOTS.length]
  // `SLOTS` is non-empty and the modulus is in range, but the compiler cannot
  // see that through the index signature.
  return slot ?? SLOTS[0]
}

/**
 * FNV-1a over the family name.
 *
 * Any stable hash would do. This one is four lines and has no dependencies.
 *
 * @param value - the family name.
 * @returns a non-negative 32-bit hash.
 */
function hash(value: string): number {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193)
  }
  return result >>> 0
}
