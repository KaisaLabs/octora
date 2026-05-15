# AGENTS.md

Repo-level configuration for AI coding agents (Claude Code, Codex, etc.).

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, defaults kept verbatim (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: `programs/`, `octora-api/`, `octora-web/` each with their own `CONTEXT.md` and `docs/adr/`, plus a root `CONTEXT-MAP.md` and root `docs/adr/` for system-wide decisions. See `docs/agents/domain.md`.
