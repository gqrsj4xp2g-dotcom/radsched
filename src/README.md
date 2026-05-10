# Modular RadScheduler source

This directory is the **future home** of the modular source. Today the
deployed `index.html` is still the canonical edit target (1.7M, ~38k
lines). Splitting it without breaking the running app + autoship daemon
takes a careful migration. This README captures the plan.

## Goals

1. **Faster audits** — find one feature without `grep` across 38k lines
2. **Safer edits** — a typo in one module doesn't risk the whole app
3. **No autoship change** — the disk-watch autopush daemon, GitHub Pages
   deploy workflow, and `index.html` URL must keep working unchanged.
   The deployed artifact stays one HTML file with everything inlined.

## Architecture

The deployed `index.html` is built by **concatenating** the modular
sources. Source files live in `src/parts/` and are stitched together by
`tools/build-index.sh`:

```
src/parts/
  00-doctype-head.html       # <!doctype html><head>...</head>
  10-css-tokens.html         # CSS variables + reset
  20-css-layout.html         # layout + sidebar + topbar
  30-css-components.html     # buttons, cards, tables, modals
  40-css-mobile.html         # @media (max-width:1024px) + 640px blocks
  50-html-overlay.html       # loading overlay + auth screen
  60-html-app.html           # the entire <div id="app">…</div>
  70-html-modals.html        # all modal containers
  80-script-cdn.html         # <script src="…xlsx…"> + supabase loader
  90-script-tune.html        # _TUNE constants (already a module)
  91-script-state.html       # S = {…} + reactive proxy
  92-script-persist.html     # _pushToSupabase / _loadFromSupabase
  93-script-render.html      # all render* + _afterMutation
  94-script-auto-assign.html # MCF + greedy solvers
  95-script-widget-admin.html # widget pairing + install kit
  96-script-other.html       # everything not yet extracted
  99-end.html                # </body></html>
```

`tools/build-index.sh` is a one-line `cat src/parts/*.html > index.html`.
That's it.

## Migration path (incremental, never breaks the app)

1. **Today**: edit `index.html` directly (the file used at runtime).
2. **Migration step N**: extract one logical block from `index.html`
   into a `src/parts/NN-name.html` file. Update `tools/build-index.sh`
   to include it. Run the build → diff vs. the original `index.html`.
   Should be byte-identical.
3. **Migration step N+1**: switch the canonical edit target for THAT
   block from `index.html` to `src/parts/NN-name.html`. Add a comment
   in `index.html` warning future editors to edit the source instead
   (or replace the block with a sentinel that the build re-fills).
4. Continue until everything is modularized.
5. Eventually `index.html` becomes a build artifact — but the build
   stays trivial (`cat`), so editors can still inspect / patch.

The build is integrated into the GitHub Pages CI in `.github/workflows/
deploy.yml` — see *Build hook* below.

## Build hook in deploy.yml

The deploy workflow runs `tools/build-index.sh` BEFORE uploading the
GitHub Pages artifact. If `src/parts/` is empty (today's state), the
build is a no-op and the existing `index.html` ships unchanged. As
modules get extracted, the build progressively takes ownership.

## What's NOT in this scope

- No webpack, vite, esbuild, rollup. The whole point is "stays simple
  enough to inspect with `cat`."
- No source maps. The deployed file IS the debug target — same line
  numbers as your source after `cat`.
- No JS module loading (`<script type="module">`). All code stays
  inline in one giant `<script>` tag, same as today.
- No CSS preprocessor. Plain CSS, just split into multiple files for
  readability.

## Blocks that CAN'T be extracted (special-cased)

A few regions in index.html are RUNTIME-MUTATED by the app itself:

- **`let S = /*S_START*/ {…} /*S_END*/`** — the in-memory state
  literal. `hardSave()` replaces this region in-place with the
  current runtime state when the user clicks 💾 Save File or when
  the disk-watch autopush fires. If we let `build-index.sh` also
  manage this region, the two would race: a build would erase the
  user's saved state, an autopush would erase the build's seed.
  Skip this one.
- **`let USERS = /*USERS_START*/ […] /*USERS_END*/`** — same story
  as above; the runtime user roster gets persisted in-band.

Everything else (CSS, layout HTML, page templates, render functions,
solvers) is fair game for extraction.

## Currently extracted

| Region | Source file | Lines saved from index.html |
|---|---|---|
| CSS design tokens | `src/parts/css-tokens.css` | ~17 |
| Mobile media queries | `src/parts/css-mobile.css` | ~111 |
| Auth screen styles | `src/parts/css-auth.css` | ~42 |
| Component CSS (cards/btns/tables/modals) | `src/parts/css-components.css` | ~137 |
| Desktop Widget admin page (HTML) | `src/parts/page-widget.html` | ~61 |

## Marker styles supported

The build script supports two comment-style markers:

- **CSS / JS contexts**: `/* @MARKER_BEGIN ... */` ... `/* @MARKER_END */`
- **HTML contexts**: `<!-- @MARKER_BEGIN ... -->` ... `<!-- @MARKER_END -->`

The extractor tries CSS-style first then HTML-style. Use whichever
matches the surrounding syntax — comments must be valid in their host
context or the HTML/CSS parser will choke.

## Recommended next extractions (in order)

1. ~~**Auth screen CSS**~~ ✅ DONE
2. ~~**Component CSS** (cards, buttons, tables, modals)~~ ✅ DONE
3. **Page templates** (`<div id="page-X">…</div>` blocks) — ~50 lines each, ~20 pages total
4. **Refined design layer** (`@media`-less overrides at ~line 470+) — pure CSS, no coupling
5. **Auto-assign solver** — DEFERRED (deeply coupled across many fns)
6. **Render functions** — biggest single block (~10k lines), do last

### Why auto-assign is deferred

The MCF + greedy solvers (`_dr_assignMCF`, `_dr_assignGreedy`,
`previewAA`, `applyAA`, plus IR equivalents and shared helpers like
`_hasIRShiftOnDate`, `_has2ndOr3rdShift`, `drEffectiveTarget`,
`_filterCellsByPeriod`, etc.) span lines ~28500–30500 and are NOT
contiguous — they're interleaved with non-auto-assign helpers and
share private state via module-level closures. A safe extraction
needs:

  1. A function-dependency analysis to find every closure relationship
  2. Hoisting helpers to either the top or below the extracted block
     (or moving them too)
  3. A test pass that runs auto-assign against a fixture practice
     to confirm output is byte-identical

Estimated effort: 2-4 hours of careful work + a stress test that
confirms the same MCF assignment for the same input. Worth doing
when the auto-assign code becomes the primary edit target — for now
it's stable and rarely touched.

## Verification before each migration step

After extracting a block, the build output should match the runtime
file byte-for-byte:

```bash
./tools/build-index.sh > /tmp/built-index.html
diff index.html /tmp/built-index.html && echo "✓ Identical"
```

If the diff is non-empty, the extraction left whitespace or content
behind. Fix before swapping the canonical source.
