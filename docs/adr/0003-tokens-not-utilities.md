# ADR-0003 — Tailwind and HeroUI supply the tokens; the stylesheet keeps the decisions

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #41, #2

## Context

The inspector was reported as hard to read. Measuring it — rather than
squinting at it — found the guess was wrong in an instructive way. Most of the
text ratios passed: `--text` at 14.43:1, `--text-muted` at 5.92:1. What failed
was the _structure_. `--surface` against `--surface-raised` was 1.07:1 and
`--border` against `--surface` was 1.28:1, so the three columns, the panel
headers and the row hover state were all doing nothing an eye could detect. One
text token did fail — `--text-faint` at 3.03:1 — and it painted the seq and
clock columns of every row in the log, at 12px.

Two questions had to be answered, and they are independent.

**Where do the colours come from?** 225 lines of bespoke CSS, tuned by eye
against no reference, is how you arrive at 1.07:1 and not notice. A design
system ships scales that have been through this already.

**Where do the colour _decisions_ live?** ADR-0002 and #2 put domain state
outside the view layer; the same instinct put colour behind semantic names in
`theme.css` rather than in markup. Tailwind's default idiom is the opposite:
`text-[#8792a5]` in JSX. Adopting Tailwind wholesale would scatter across a
dozen components exactly the decisions this project deliberately centralised —
and would break the selector contract (`.panel`, `.event-row`, and the rest)
that the test suite asserts against.

## Decision

1. **Tailwind v4 via `@tailwindcss/vite`, and no `tailwind.config.js`.** v4 is
   CSS-first; there is no `content` array to keep in step and no plugin array.
   HeroUI v3 requires Tailwind v4 (`peerDependencies.tailwindcss` is `>=4.0.0`),
   so this is not optional if HeroUI is in.

2. **Tokens from the design system, decisions in the stylesheet.** The palette
   is declared once in `theme.css` under HeroUI's own semantic names, and
   `inspector.css` names tokens and never hex. Utility classes are not sprayed
   through JSX — not for colour, not for layout. Every selector the tests rely
   on survives unchanged.

   The practical test for a future change: if you are about to write a colour
   in a `className`, it belongs in `theme.css` instead.

3. **HeroUI's _theme_, not its component stylesheet — for now.** Measured on
   this page: `@heroui/styles` in full is 407 kB raw / 38.7 kB gzipped, almost
   all of it styling components the inspector does not render.
   `@heroui/styles/themes/default` is 32 kB / 5.1 kB and carries the part we
   came for — the semantic scales, their light/dark pairings, and the
   `@theme inline` block that maps them onto Tailwind's colour utilities. Add
   `@heroui/styles/components/<name>.css` with the first component that is
   actually used, or switch to the full import once enough are.

4. **Where HeroUI's defaults fail this layout, they are overridden — and the
   override is measured.** HeroUI is tuned for cards floating on a page, where
   a shadow separates them. Measured against an edge-to-edge three-column log
   it repeats the fault being fixed: `surface` vs `background` at 1.14:1,
   `border` vs `surface` at 1.21:1, and light-mode `muted` at 4.21:1 on a
   secondary surface, which fails AA outright. Adopting a design system is not
   a substitute for measuring; it is what makes measuring cheap.

   Our overrides are unlayered, so they beat HeroUI's `@layer theme` without a
   specificity contest, and HeroUI components inherit our palette for free.

5. **`light-dark()` over duplicated scheme blocks.** Each token is one
   declaration carrying both values, under `color-scheme: light dark`. The page
   follows the operating system with no JavaScript, the two values cannot drift
   apart in review, and the manual override is one line that pins
   `color-scheme` — which is also the `data-theme` selector HeroUI keys off.

6. **The scheme lives outside React.** It is UI state, not domain state, so it
   is the one legitimate exception to "no `useState` in `apps/web`" — and it
   still does not take it. A module-level store with `useSyncExternalStore`
   keeps the choice out of any component above the panels, so flipping the
   theme re-renders the toggle and nothing else, exactly as an arriving event
   re-renders one column and nothing else.

   HeroUI ships a `useTheme` hook that does almost this. It is not used: it
   holds the choice in `useState` inside whichever component calls it, and its
   subscriber calls `window.matchMedia(...)` unguarded, which throws in jsdom —
   where this suite runs.

7. **The palette's acceptance criterion is a number.** `test/contrast.test.ts`
   parses `theme.css`, resolves every `light-dark()` pair through an Oklch to
   sRGB conversion, and asserts WCAG 2.2 SC 1.4.3 (4.5:1, because 12px
   monospace is not "large text") for every text-on-surface pair it can
   actually produce, and SC 1.4.11 (3:1) for every boundary that carries
   structure. A colour retuned by eye fails a test rather than a user.

## Consequences

- The bundle grew: CSS from 3.09 kB / 1.14 kB gzipped to 33.4 kB / 5.3 kB, and
  JS by 1.5 kB / 0.6 kB gzipped — no HeroUI component is imported, so almost
  none of its JavaScript is. Roughly 4.7 kB gzipped in total, for a measured
  palette, a light mode, and a component library that is now one import away.
  The 37 kB gzipped version of the same thing was declined.
- There is no `tailwind.config.js` to look for. Class ordering is unenforced —
  neither oxfmt nor oxlint has an opinion on it — which costs nothing while
  utilities stay out of the markup, and is a reason to keep them out.
- Adding a HeroUI component means adding its stylesheet in `app.css`. That is
  deliberate friction: it puts the size of each component in front of whoever
  adds it.
- `@tailwindcss/vite` loads in the Vitest `web` project too, since
  `apps/web/vite.config.ts` is that project's config. It is inert there —
  Vitest does not process CSS, so the plugin never sees a file to transform.
  Confirmed, not assumed: the suite runs unchanged.
- Every family colour now has a light variant derived from the dark one by
  moving lightness alone, so a family is recognisably the same colour in both
  schemes. `event-colour.test.ts` checks each token _resolves_ in both schemes
  rather than merely appearing in the file as a substring.
