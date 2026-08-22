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
- **Breaking changes**: append `!` after the type/scope *and* add a `BREAKING CHANGE: <what broke and why>` footer.
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
