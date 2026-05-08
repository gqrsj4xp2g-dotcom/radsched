# Contributing to RadScheduler

> Welcome! This doc covers what we expect from changes — the workflow,
> what to check before opening a PR, and the conventions that keep the
> single-file codebase readable.

## TL;DR

1. Branch from `main`. One feature per branch.
2. Edit `index.html`. Keep changes scoped to one section.
3. Run the in-page regression suite (Tools → run-tests).
4. Run the parse check: `python3 tools/parsecheck.py` (if installed).
5. Open a PR; describe **what** changed and **why**.
6. Squash on merge. Commit subject line stays under 70 chars.

## Workflow

```
# new branch
git checkout -b feat/short-name

# work
$EDITOR index.html

# parse check (uses jsc on macOS, node elsewhere)
./tools/parsecheck.sh

# in-browser smoke test
open index.html
# → log in, exercise the touched feature, run the regression suite
# → check the audit log for "as expected" entries

# commit and push
git add index.html
git commit -m "feat: short description"
git push -u origin feat/short-name

# open PR via gh
gh pr create --fill
```

## What goes where

The script tag in `index.html` has a module table-of-contents at the
top. New code goes into the section that matches its purpose; create
a new section only when nothing fits. Update the TOC when you add a
section.

| Change kind | Section |
|-------------|---------|
| New form on Tools page | §31 |
| New AI capability | §22 |
| New auto-assign rule | §32 (DR/IR engines) |
| New persistence field | §2 (add to PERSISTED_KEYS) + §8 (migration) |
| New visual polish | §39 |

## Coding style

See `docs/CODING-STYLE.md` for the full set. Key rules:

- 2-space indent. No tabs.
- Single quotes for strings. Backticks for templates.
- `_` prefix on internal functions; bare names on inline-onclick targets.
- Always `_audit('action.name', detail)` after a mutation.
- Always call `_afterMutation()` after a bulk operation.
- Never reference `S.something` in DOM string templates without
  `escHtml` if it could be user content.

## Things to check before opening a PR

| Check | Why |
|-------|-----|
| Regression suite passes (Tools → tests) | Nothing core regressed. |
| Audit log shows the new mutation | The action recorded what it did. |
| Reload still works | No init-order problem. |
| Two tabs open at once | Leader election still works; updates fan out. |
| Open in private window | Cookies / storage isolation OK. |
| Lighthouse PWA score | Manifest + service worker still valid. |
| Print preview of a calendar | Print stylesheet not broken. |
| Sign-in flow | Auth bootstrap still works. |
| Excel import a known file | Parser still produces the same counts. |

## Pull request template

Use this skeleton:

```
## Summary
What changed in 1–3 bullet points.

## Why
Link an issue or describe the user-facing motivation.

## Test plan
- [ ] Action A produces outcome B
- [ ] Edge case C handled gracefully
- [ ] Audit log shows the new entries
- [ ] No regressions in untouched tabs
```

## Code review

A maintainer will look for:

1. **Scope creep**. Did the diff touch unrelated lines? Revert them.
2. **Imports + escapes**. Anything user-typed must go through `escHtml`
   before HTML interpolation.
3. **Audit log**. Every mutating button should record its action.
4. **Reactivity**. Bulk array mutations should call `triggerSave()`.
5. **Mobile**. Did you check the touch-target size? 44×44 minimum.
6. **Dark mode**. Use CSS variables, not hard-coded colors.
7. **Backwards compatibility**. Migrations must handle missing fields.

## Releasing

Pushes to `main` deploy automatically (GitHub Pages, Netlify, or Vercel
depending on host). Bump `CACHE_VERSION` in `sw.js` when `index.html`
changes; this evicts old shells on the next `activate` event.

The git log is the change log. Use conventional-commits-style subjects
(`feat:`, `fix:`, `chore:`, `docs:`) so the log scans cleanly.

## Getting help

- Open an issue on GitHub with the audit + error log attached.
- Settings → Tools → Error log → Export gives you the bundle.
- Tag urgent issues with the `urgent` label.
