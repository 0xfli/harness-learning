# AGENTS.md

Guidance for coding agents working in `harness-learning`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `0xfli/harness-learning`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Project conventions

### Code style and checks

Style is decided by tools, not by review. Never hand-format code, and never
argue with the formatter.

- **Format** with [oxfmt](https://oxc.rs): `pnpm run format`, or `pnpm run format:check`
  to verify. `.oxfmtrc.json` is the whole style guide — single quotes, no
  semicolons, everything else oxfmt's defaults.
- **Lint** with [oxlint](https://oxc.rs): `pnpm run lint`, or `pnpm run lint:fix` to
  autofix. `.oxlintrc.json` promotes the `correctness`, `suspicious` and `perf`
  categories to errors.
- **Everything**: `pnpm run check` runs format check, lint, typecheck and tests —
  the same gate CI runs on every pull request.

Silence a lint rule in the config, with the reason, rather than sprinkling
inline `oxlint-disable` comments. A rule that is wrong for this codebase is
wrong everywhere in it.

### Git hooks

[husky](https://typicode.github.io/husky/) hooks live in `.husky/` and are installed
by `pnpm install`:

| Hook         | What it enforces                                   |
| ------------ | -------------------------------------------------- |
| `pre-commit` | `lint-staged` — formats and lints the staged files |
| `commit-msg` | the subject line is a Conventional Commit          |
| `pre-push`   | `pnpm run typecheck` and `pnpm run test` pass      |

`--no-verify` is for emergencies, not for a hurry. If a hook is wrong, fix the
hook.

### Branching and merging

- **Never commit directly to `main`.** `main` is integration-only and is updated exclusively by merging a pull request.
- Do the work on a topic branch, then open a PR against `main`.
- Branch names follow `<type>/<short-kebab-summary>`, using the same types as Conventional Commits — e.g. `feat/tool-call-loop`, `fix/stream-parser-eof`, `docs/agent-setup`.
- Keep a PR scoped to one logical change. If a branch grows a second concern, split it.

### Conventional Commits

Every commit message **and** every PR title follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Description**: imperative mood, lowercase, no trailing period, ≤ 72 characters.
- **Scope** is optional and names the affected area, e.g. `feat(agent): add tool-call loop`.
- **Breaking changes**: append `!` after the type/scope _and_ add a `BREAKING CHANGE: <what broke and why>` footer.
- Reference issues in the footer: `Closes #12`, `Refs #12`.

Examples:

```
feat(harness): stream assistant deltas to the terminal
fix(parser): handle truncated SSE frames at EOF
docs: record ADR for the tool-call protocol
refactor(agent)!: replace callback loop with async iterator

BREAKING CHANGE: `runAgent` now returns an AsyncIterable instead of taking an onEvent callback.

Closes #12
```

### Pull requests

- PR **title** is a Conventional Commit line — it becomes the squash-merge commit subject.
- PR **body** states what changed and why, and links the issue it resolves (`Closes #<n>`).
- Prefer **squash merge** so `main` keeps one Conventional Commit per PR.
- Delete the branch after merge.
