# Agent rules

These rules apply to **every** AI / coding agent working in this repository
(Claude Code, Codex, Cursor, Copilot, Gemini, Windsurf, Aider, etc.). The other
agent-instruction files in this repo (`CLAUDE.md`, `GEMINI.md`, `.cursorrules`)
mirror this file.

## No AI / agent attribution

Do not add any AI- or coding-agent attribution, branding, or metadata to any
artifact in this repository, including but not limited to:

- **Commit messages** — no `Co-Authored-By:` an AI model/tool, no "Generated
  with …" lines, no session links, no agent/model trailers.
- **Pull requests** — no agent attribution in titles or descriptions.
- **Code** — no comments crediting or referencing a coding agent/model.
- **Docs / READMEs / any file** — no agent branding, badges, or notes.

Write commits, PRs, code, and docs as a normal human contributor would; keep
authorship as the configured git user only.

Note: this constrains the *coding assistant* working on this repo. It does **not**
apply to GitView's own product, which legitimately references Claude — the whole
point of the app is browsing a repo and chatting to a Claude session. Product
concepts like "Claude", the "Claude Agent SDK", the remote-control / chat
features, and the `bridge/src/claude/` modules stay exactly as they are.

## No committing or pushing during Pacific work hours

Do not `git commit` **or** `git push` during **Monday–Friday, 08:00–18:00
America/Los_Angeles (Pacific)**. Within that window, keep changes in the working
tree only (staging is fine) — nothing may be committed or reach the remote.

Commit and push only outside the window — before 08:00, after 18:00 PT, or on
weekends. Because commits are then made off-hours, their dates are already
correct and need no restamping. (Fallback only: if a commit somehow lands during
work hours, restamp its author **and** committer date before pushing so history
reflects off-hours work — one commit
`GIT_COMMITTER_DATE="$(date)" git commit --amend --no-edit --date=now`; several
`git rebase --exec 'GIT_COMMITTER_DATE="$(date)" git commit --amend --no-edit --date=now' <base>`.)

Check the current time with `TZ=America/Los_Angeles date`. An explicit user
request to commit or push now overrides this rule.
