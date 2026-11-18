# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `reyn-time/n8n-nodes-stagehand`. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open` and appropriate label filters.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue with `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Blocking relationships

Use GitHub native issue dependencies when available. Add a blocker with:

`gh api --method POST repos/reyn-time/n8n-nodes-stagehand/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`

Use the blocker's numeric database ID, not its issue number. If native dependencies are unavailable, record `Blocked by: #<number>` in the issue body.
