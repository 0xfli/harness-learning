# ADR-0006 — Tint, elevation and motion are scales, and the palette pays for the first one

- **Status**: accepted
- **Date**: 2026-08-22
- **Refs**: #46, ADR-0003

## Context

ADR-0003 settled where colour lives and how it is checked, and the result was a
page that measured well and looked like nothing. Everything on it was flat:
1px borders in every direction, plain text in five sizes, one uppercase label
per column, no hover worth noticing, no depth, no radius above 0.35rem. It read
as a debug view somebody had not got round to, which is a poor advertisement
for the thing it is inspecting.

Reaching for the obvious fix — a shadow here, a `border-radius: 12px` there,
a `transition: all 0.2s` on whatever felt sluggish — would scatter across the
stylesheet exactly the class of decision ADR-0003 pulled into one file. A
radius spelled out in forty places is a proportion nobody can retune, and a
duration spelled out in twenty is a feel nobody can adjust.

The interesting constraint turned up in the palette. The nicest single move
available — writing an event type on a chip washed with its own family colour,
so the left column reads as designed rather than as printed — costs contrast,
because the wash pulls the background towards the text. Measured against the
palette as it stood, the budget was **6%**: a wash nobody can see. Every family
colour sat at roughly 5.0:1 against the row behind it, which cleared AA by two
tenths of a point and bought nothing with the rest.

## Decision

1. **Tint, elevation, radius and motion are scales in `theme.css`, alongside
   the colours.** `inspector.css` names `--radius-md`, `--shadow-sm`, `--fast`
   and `--ease`; it does not spell out a length, a shadow or a duration, for
   the same reason it does not spell out a hex.

2. **A shadow means "this floats over something that scrolls", and nothing
   else.** The inspector header, the three panel headers and the composer's
   footer cast one, because a column moves underneath them. The columns
   themselves cast none — they are side by side in one plane, and ADR-0003's
   3:1 border is what separates them. Three steps in the scale, plus one inset
   for a control that is pressed into the page rather than raised out of it.

3. **A chip is tinted with the colour written on it, and the tint is
   measured.** `test/contrast.test.ts` reads `--tint` out of the stylesheet,
   composites each family colour over each surface it can land on, and asserts
   4.5:1 against the result — resting and hovered for a log row, on both fills
   for a turn. Raising the tint is now a change the test has an opinion about.

4. **The family palette was retuned to afford it.** Every family colour, the
   three feed-health colours and the accent moved in lightness alone —
   0.44–0.48 in light mode, 0.71–0.75 in dark, up from a flat ~0.49/0.68. The
   hue and chroma of each are untouched, so ADR-0003's "one hue across both
   schemes" still holds and every family is the same colour it was, said
   louder. Base contrast goes from ~5.0:1 to ~5.9:1, which is what pays for a
   12% tint with a third of a point still in hand.

5. **The neutrals are cool, and no fill is white.** The four structural fills,
   both weights of rule and all three weights of text sit on one hue — 262 —
   with chroma from 0.004 to 0.018, and `--surface` stops just short of white
   at 0.984. A dead-neutral ramp under a paper-white panel is what makes a
   dense tool read as a printed form; one hue running through the whole ramp
   is what makes three columns read as one surface with light on it. The
   accent is that same hue at forty times the chroma, so the one saturated
   thing on the page is saturated on purpose rather than borrowed.

6. **`--on-accent`, because the accent crosses over.** The send button is the
   one filled control on the page, and `--accent` is a mid blue in light mode
   and a bright one in dark. White text would fail in exactly one of the two
   schemes, so the ink is a token with a light and a dark value like everything
   else, measured on both `--accent` and its hover step.

7. **Motion is ambient or it does not exist.** Two things move on their own:
   the caret under a streaming reply and the ring around a live feed. Both are
   restatements — the caret's state is in `data-state`, the ring's is in the
   word beside it — so both stop under `prefers-reduced-motion` and nothing
   goes with them. Everything else that moves is answering a pointer, and does
   it in `--fast`.

## Consequences

- CSS grew from 33.4 kB / 5.3 kB gzipped to 43.2 kB / 7.1 kB. No new
  dependency, no new component library import, no JavaScript at all: the mark
  in the header is two gradients, and every chip is `color-mix`.
- The contrast suite went from 62 assertions to 88, and the helper it runs on
  gained `mix` and `readPercentage`. `mix` is checked against the three values
  anyone can verify by hand, for the same reason `contrast` and `oklch` are.
- Retuning the palette moved every colour in the file — fourteen for the tint,
  and then the nine neutrals for the hue. That is exactly the change ADR-0003's
  test exists to make safe, and it was: the numbers were solved for, applied,
  and the suite said so. The cool ramp passed all 88 assertions unaltered,
  which is the whole argument for measuring a palette rather than agreeing
  about it.
- Moving the neutrals onto a hue spends contrast headroom that a grey ramp does
  not: `--surface-secondary` clears its panel body by 1.11:1 against a floor of
  1.1, and the hover step clears 1.2:1 by two hundredths. Both are the test's
  to defend now, and either one is a reason a future lightening of `--surface`
  fails rather than quietly flattens.
- `color-mix()` and `light-dark()` are both Baseline 2024. The inspector is a
  development tool served by Vite to whatever the developer is running; it does
  not carry a fallback for browsers that predate them.
- The tint is one number for every chip on the page. A chip that wants a
  stronger wash does not get one — it argues for raising `--tint` for
  everybody, and finds out from the test what that costs.
