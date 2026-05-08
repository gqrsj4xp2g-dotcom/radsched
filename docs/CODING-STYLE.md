# RadScheduler — Coding style

> One-file deployment. Conventions matter more than usual because the
> normal lint/format/build tooling doesn't apply.

## Files + format

- **One artifact**: `index.html`. All CSS/JS inlined.
- **Indent**: 2 spaces. Never tabs.
- **Line length**: soft 100, hard 120.
- **Newline at EOF**: required.
- **Trailing whitespace**: forbidden.

## JavaScript

### Variables
- `const` by default. `let` only when reassigning.
- `var` is allowed only inside the inline classifier helpers where
  hoisting is depended on (rare).
- Top-level globals are by design — there's no module system. Prefix
  internals with `_`.

### Strings
- Single quotes for short literals.
- Backticks for template strings or anything multi-line.
- HTML emitted via templates **must** wrap user input in `escHtml(…)`.

### Naming
- Functions: `verbNoun` camelCase. e.g. `applyAA`, `renderCalendar`.
- Internal-only: `_underscorePrefix`. e.g. `_audit`, `_physById`.
- Boolean flags: `isAdmin`, `hasVacation`. Never `flag1`.
- Constants: `SCREAMING_SNAKE` only for true constants
  (`SUPABASE_URL`, `_MIGRATIONS`).

### Function size
- Aim for ≤80 lines per function. If it gets bigger, factor inner
  loops into named helpers; readability matters more than DRY.

### Comments
- Explain **why**, not what. The code shows what.
- Each section in the script gets a `// ── Section name ──` banner.
- New public-ish helpers get a JSDoc block:
  ```
  /**
   * One sentence summary.
   * @param {Type} name — what it represents.
   * @returns {Type} what it returns.
   */
  ```

### Error handling
- Async paths use `try/catch` and surface user-friendly messages via
  `_toast(msg, 'err')`.
- Sync paths rely on the global error handler (§1) — but throw
  with a message that names the function: `throw new Error('renderXxx: …')`.
- Never swallow errors silently. If you `catch(_) {}`, leave a
  comment explaining why it's safe.

### Audit + state hooks
- Every mutation must call `_audit('action.name', detail)`.
- Bulk mutations must call `triggerSave()` and `_afterMutation()`.
- Destructive ops should snapshot first via `_snapshotBeforeBulk(label)`.

## CSS

- Variables only. Never hard-code colors. The full theme set is in
  `:root`.
- Class names use `bp` (button primary), `bsm` (button small),
  `bd` (button danger), `br` (button reset). Avoid inventing new
  button classes.
- One stylesheet, top-of-file in a single `<style>` block. Append to
  the bottom of the existing block, not a new tag.
- Print rules go inside `@media print { … }` blocks.

## HTML

- Form inputs that drive renders should have `oninput="..."` calling
  the relevant render function.
- Buttons that mutate must use a function that records to the audit log.
- Section IDs follow `page-X` (e.g. `page-tools`).
- Inline event handlers are OK; the script is a single block, so all
  globals are addressable.

## Security checklist

- [ ] Never write `${userText}` directly into HTML — always
  `${escHtml(userText)}`.
- [ ] Every fetch to an edge function includes
  `Authorization: Bearer ${session.access_token}`.
- [ ] No `eval`, `Function(...)`, or innerHTML of unescaped user input.
- [ ] No credentials in URLs.
- [ ] CSP headers set in `_headers` (Netlify) and `vercel.json` (Vercel).

## Accessibility

- All buttons need a `title` (tooltip) when their label is an emoji.
- Focus rings: never `outline: none` without a replacement.
- Tab order should follow visual order.
- Color contrast: aim for WCAG AA (4.5:1 for normal text, 3:1 for large).
- ARIA: use `role="toolbar"`, `aria-label="…"` on bulk-action bars
  and similar dynamic regions.

## Git

- Branch names: `feat/short-name`, `fix/short-name`, `chore/short-name`.
- Commit subject ≤70 chars. Body explains why if not obvious.
- Squash on merge. One feature → one commit on `main`.
- Conventional commit prefixes: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `perf`.

## What we don't do

- ❌ TypeScript-on-the-fly via `// @ts-check`. (Doc comments instead.)
- ❌ Preprocessors for CSS.
- ❌ Module bundlers.
- ❌ Frameworks (React, Vue, etc.). The DOM is the framework.
- ❌ npm dependencies in the client. Only CDN scripts via `<script src>`.
