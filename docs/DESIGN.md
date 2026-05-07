# Design

A scheduler runs in the background of someone's day. Most of the time the
right amount of attention to give it is none. The interface should
disappear into the work.

This document records the design choices that follow from that — what
they are, and why they are.

---

## Principles

### Restraint over ornament

Every visual element earns its place. A divider only exists when grouping
breaks down without it. A button is colored only when it carries the next
intended action; everything else is a ghost. The accent color appears
sparingly — when it does, it means something.

### Honest materials

No simulated glass, no pretend depth, no decoration mistaken for
information. Surfaces are flat with subtle shadow when elevation is real
(modals, toasts). The system font stack is used so type renders at OS
quality on every device — San Francisco on Apple, Segoe UI on Windows,
Inter on the rest.

### Considered motion

One easing curve: `cubic-bezier(0.4, 0, 0.2, 1)`. One default duration:
200ms. Toasts ease in 4px from the right. Cards fade at 240ms. Press
states scale to 0.98. Nothing bounces. Nothing draws attention to its
own movement.

### Density that respects the work

Schedules are dense by nature. The cells stay tight; the chrome stays
loose. The eye moves to data, not borders.

### Clarity at every scale

Touch targets are 40px minimum. The mobile drawer locks body scroll while
open and releases it cleanly when crossing the breakpoint up. ESC closes
overlays. `aria-expanded` mirrors the drawer state. Focus rings are
visible but unobtrusive.

---

## Tokens

The full token set lives in `:root` of `index.html`. Highlights:

### Type

- **Stack**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Helvetica Neue", sans-serif`
- **Base size**: 14px (was 13px)
- **Body line-height**: 1.55
- **Tracking**: -0.011em on body, -0.022em on titles (Apple-style negative tracking on display sizes)
- **Weights**: 400 / 500 / 600 / 700 only

### Scale

```
caption  11px / 1.4
body     14px / 1.55
section  18px / 1.4
title    22px / 1.3
hero     32px / 1.2
```

### Color (light)

```
--bg0   #ffffff   primary surface
--bg1   #fafafa   page background
--bg2   #f4f4f6   subtle surface
--bg3   #e8e8eb   hover/sunk
--ink1  #0a0a0c   primary text
--ink2  #4a4a4f   secondary text
--ink3  #98989a   tertiary text
--line  rgba(60, 60, 67, 0.13)  hairline
--accent #2563eb  meaningful action
```

### Color (dark)

```
--bg0   #1c1c1e   primary surface
--bg1   #0a0a0c   page background
--bg2   #232325   subtle surface
--bg3   #2c2c2e   hover/sunk
--ink1  #fafafa   primary text
--ink2  #c6c6ca   secondary text
--ink3  #98989a   tertiary text
--line  rgba(255, 255, 255, 0.10)  hairline
--accent #4d8cff  meaningful action
```

### Spacing

A geometric scale based on 4px:

```
xs   4
sm   8
md   12
base 16
lg   24
xl   32
2xl  48
```

### Radii

```
sm   6     small chips, tags
md   10    buttons, inputs
lg   14    cards
xl   18    modals
full 9999  pills, avatars
```

### Shadows

```
elev-1   0 1px 2px rgba(0,0,0,0.04)            buttons, sticky bars
elev-2   0 4px 12px rgba(0,0,0,0.08)           toasts, dropdowns
elev-3   0 10px 40px rgba(0,0,0,0.12)          modals
```

### Motion

```
ease     cubic-bezier(0.4, 0, 0.2, 1)
fast     150ms
base     200ms
slow     300ms
```

---

## Components

### Toolbar

Black-tier deep navy on top. Contains brand mark, practice name, save
indicator, action triplet. Buttons stay quiet except `Save File`
(intentional accent). Avatar is a colored circle with two-letter
initial — no photo.

### Sidebar

Vertical list, single column on desktop, drawer on mobile (slide in from
the left, body scroll locked). Section headers are tertiary-ink uppercase
caption type. Items have only the active row highlighted; the rest are
text-only.

### Cards

White surface, hairline border, soft shadow. Header is one line:
`title-icon  Title`. Body content gets generous internal padding. Cards
do not nest more than two deep.

### Buttons

Three weights:

- **Primary** (`bp`): accent background, white type, used for the single
  intended next action on a page.
- **Secondary** (`bsm` etc.): ghost border, ink-2 type, hover bumps to
  `bg2`. Used for everything else.
- **Destructive** (`br`): only appears in confirm dialogs and explicit
  delete buttons. Red type on hover; never as the default visual weight.

### Save indicator

A 10px caption to the left of `Save File`. Empty most of the time; shows
`✓ Synced` for 3s after a push, `⏳ Saving…` during, `⚠ ...` red text on
failure with longer dwell. The stale-save badge appears red when nothing
has synced in 5 minutes; clicking it forces a retry.

### Toast

Floats top-right. Slides in 4px from the right at 250ms. Three types:
ok (green), info (blue), warn (amber). Click to dismiss; auto-dismiss at
3s (5s for warn).

### Modals

Center-aligned, max 480px wide on mobile, 560px wide on desktop. Backdrop
is 50% black with backdrop-blur on supporting browsers. Corners 18px.
ESC closes.

### Calendar

Cells are 1px hairline-separated, no double borders. Weekend cells have a
faint background tint. Today is marked with a 2px accent ring (not
filled). Events inside cells are 11px caption type, ellipsized.

---

## What this is _not_

- Not skeuomorphic. There is no notebook texture, no clipboard, no paper.
- Not minimalist for its own sake. We keep dense data dense.
- Not animated for delight. Motion exists to confirm intent only.
- Not heavily branded. The product is a tool. The user's data is the
  brand.
