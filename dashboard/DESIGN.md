---
name: Factory dashboard
description: A quiet control room over the software factory's production line.
colors:
  signal-teal: "#1b6c80"
  ink: "#131416"
  ink-button: "#1d1f20"
  muted-ink: "#5d5f60"
  frame-ground: "#f6f8f9"
  sheet: "#ffffff"
  raised: "#f4f6f8"
  active: "#ebedee"
  border: "#e8eaec"
  rule: "#f0f1f2"
  input-stroke: "#cdced1"
  switch-off: "#8b8d90"
  positive: "#1e7b4f"
  destructive: "#c4242a"
  pill-positive-bg: "#dcfae5"
  pill-positive-ink: "#04250e"
  pill-negative-bg: "#ffedea"
  pill-negative-ink: "#831c1e"
  pill-warning-bg: "#fffbeb"
  pill-warning-ink: "#92400e"
  pill-neutral-ink: "#353736"
  # Dark mode: the same roles, used under prefers-color-scheme: dark or data-theme="dark".
  dark-signal-teal: "#5bb5c9"
  dark-ink: "#e6e7e8"
  dark-ink-button: "#d9dbdd"
  dark-muted-ink: "#9b9ea1"
  dark-frame-ground: "#0e1113"
  dark-sheet: "#17191b"
  dark-raised: "#1f2225"
  dark-active: "#282b2e"
  dark-border: "#2c2f32"
  dark-rule: "#222528"
  dark-input-stroke: "#42464a"
  dark-switch-off: "#6f7377"
  dark-positive: "#4cc38a"
  dark-destructive: "#f2726d"
  dark-pill-positive-bg: "#123222"
  dark-pill-positive-ink: "#a6ebbf"
  dark-pill-negative-bg: "#3d1a1b"
  dark-pill-negative-ink: "#ffbab3"
  dark-pill-warning-bg: "#33290f"
  dark-pill-warning-ink: "#f9d58a"
  dark-pill-neutral-ink: "#cdcfd1"
typography:
  headline:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "32px"
  stat:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: "32px"
    fontFeature: "tnum"
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "tnum"
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "16px"
  full: "9999px"
spacing:
  sheet-inset: "8px"
  stack-sm: "8px"
  stack-md: "12px"
  page-x: "24px"
  section: "32px"
  column-gap: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink-button}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.raised}"
  button-destructive:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.destructive}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-destructive-hover:
    backgroundColor: "{colors.pill-negative-bg}"
  pill-positive:
    backgroundColor: "{colors.pill-positive-bg}"
    textColor: "{colors.pill-positive-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  pill-negative:
    backgroundColor: "{colors.pill-negative-bg}"
    textColor: "{colors.pill-negative-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  pill-warning:
    backgroundColor: "{colors.pill-warning-bg}"
    textColor: "{colors.pill-warning-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  pill-neutral:
    backgroundColor: "{colors.active}"
    textColor: "{colors.pill-neutral-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  board-card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
  nav-item-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "36px"
---

# Design System: Factory dashboard

## Overview

**Creative North Star: "The Line Control Room"**

The dashboard is the control room over the factory's production line. A person comes in to answer one question: where is my change, and does it need me? The room is quiet. Everything is ink on a white sheet, and one hue, Signal Teal, marks what is live. Red appears only when something failed or is stuck.

The shell is a tinted blue-grey frame (sidebar and top bar on one ground, no rule between them) around a white working sheet, inset 8px on the right and bottom. The sheet holds the data. The frame holds the way around. The mark in the corner is the line itself: three stations on one rail, the last one lit.

The feel is tactile and calm. Surfaces are flat. Every clickable thing fades in 120ms and presses to 0.96 scale. Numbers are tabular so columns of cost and duration line up. Density is that of a working tool: 14px body, 32px buttons, cards that hold one line of title and one line of facts.

**Key Characteristics:**
- Tinted frame around a white sheet, with a dark mode that keeps the same two planes.
- Ink first; Signal Teal is the one hue and marks live data.
- Flat surfaces; depth comes from the frame and the sheet, not from shadows.
- IBM Plex Sans with Plex Mono for repo and ticket IDs, tabular numbers everywhere.
- Small, fast, tactile feedback on every control.

## Colors

A near-greyscale palette with one signal hue and three soft state pills.

### Primary
- **Signal Teal** (`signal-teal`): the live step's bar on the run timeline, the 2px line under the active tab, the lit station in the mark, and the focus ring. Nothing decorative ever uses it.

### Neutral
- **Ink** (`ink`): all body text and headings.
- **Ink Button** (`ink-button`): the primary button fill and a checked switch. One step lighter than Ink so a filled button does not read as a hole.
- **Muted Ink** (`muted-ink`): the one grey line under a page title, metadata, counts, empty states.
- **Frame Ground** (`frame-ground`): the frame around the sheet. A single blue-grey step.
- **Sheet** (`sheet`): the working surface, cards and dialogs.
- **Raised** (`raised`): hover fill, code and log blocks, the track behind a timeline bar.
- **Active** (`active`): the selected nav item, a secondary button, the neutral pill.
- **Border** (`border`) and **Rule** (`rule`): card and table borders; the lighter rule between timeline rows.
- **Input Stroke** (`input-stroke`): outline buttons, a tab's hover underline.
- **Switch Off** (`switch-off`): the unchecked switch track, 3.3:1 on the sheet so an off switch still reads as a control.

### State
- **Positive** (`positive`) and **Destructive** (`destructive`): solid state color for text, a failed step's bar, and destructive button strokes.
- **State pills** (`pill-*`): pale fill with dark ink of the same hue for positive, negative and warning. Neutral pills use Active with `pill-neutral-ink`.

### Dark mode
Every token has a dark value (the `dark-*` colors above). The header's Theme control offers System, Light and Dark; System follows the operating system. The rules do not change. The frame is the darkest plane and the sheet sits one step lighter on it, so the sheet still reads as the working surface. Ink turns light and stays first. Signal Teal and red lighten to keep 4.5:1 on the dark sheet, and stay the only hue and the only alarm. Pills keep the pale-fill idea inverted: a dark fill of the hue with light ink of the same hue. Floating layers keep their shadow, cast in black. The switch thumb takes the sheet color.

| Pair (dark) | Ratio |
| --- | --- |
| Ink on Sheet / on Frame | 14.2 / 15.3 |
| Muted Ink on Sheet / Frame / Raised / Active | 6.6 / 7.0 / 5.9 / 5.3 |
| Signal Teal, Positive, Destructive text on Sheet | 7.5 / 8.0 / 6.2 |
| Pill ink on its fill: positive, negative, warning, neutral | 10.1 / 9.5 / 10.2 / 9.1 |
| Switch Off on Sheet | 3.7 |

### Named Rules
**The One Signal Rule.** Signal Teal appears only on live data, the active tab, the mark and focus. If a teal element is not live or selected, it is wrong.

**The Red Means Stop Rule.** Destructive red marks a failed or stuck run, an error, or a destructive action. It never decorates.

## Typography

**Display Font:** none. The largest text is the 22px page title.
**Body Font:** IBM Plex Sans (with system-ui)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace) for repo names, ticket numbers, tool input and logs.

**Character:** Plex is an engineer's sans: plain, slightly mechanical, readable at 12px. The mono beside it marks values a person may copy.

### Hierarchy
- **Headline** (600, 22px, 32px): the page title, once per screen, in the page title row. The 32px line matches the 32px buttons beside it.
- **Stat** (400, 24px, 32px): the run page's four readouts (Now, Time, Cost, Risk): one row of four from a 768px column, two by two below it.
- **Title** (600, 16px, 24px): section headings on a page (h2), over a 1px rule. Inside a panel and for board labels the same heading drops to 14px (h3).
- **Side heading** (600, 18px, 28px): the two board sides, "Waiting on you" and "With the factory".
- **Body** (400, 14px, 20px): everything else. Set on `body` with tabular numbers.
- **Label** (500, 12px, 16px): pills, small metadata, the side captions on the board.
- **Mono** (400, 12px, 16px): `target #ticket`, tool input and results, logs.

### Named Rules
**The Tabular Numbers Rule.** Every number uses tabular figures and sits right-aligned in a fixed-width slot, so cost and duration columns line up across rows.

## Layout

From `md` (768px) the shell is a grid: a 228px sidebar and the content column, with a 48px top bar. The sheet sits in the content column with 8px of frame showing on the right and bottom, a 16px radius and a 1px border. Inside it, pages pad 24px on the sides and 24px on top.

Below `md` the frame folds into a 48px bar with a menu button (44px target) that opens the nav as a full-height panel. The sheet loses its radius and inset and pads 16px.

Every screen opens with the page title row: the h1, one grey line that states the finding ("1 to approve, 2 need an answer."), and the screen's actions on the right. 32px separates it from the content.

The board is two columns from `lg` (1024px), 48px apart: "Waiting on you" on the left, "With the factory" on the right. Each side shows a section only for a label that has tickets, 24px apart, and one muted line names the empty labels ("Stopped and Blocked are empty."). Done shows its 10 newest tickets. Cards stack 8px apart.

### Named Rules
**The One Heading Rule.** Every section opens with the shared section heading: the title, 8px, a 1px rule, 12px, then the content. No page builds its own.

**The 32px Rule.** Sections on a page sit 32px apart. 40px and 20px are off the scale.

## Elevation & Depth

The system is flat. Depth comes from two planes: the tinted frame and the white sheet on top of it. Board cards carry the smallest shadow (`shadow-xs`) only to lift them off the sheet. Hover never adds shadow. It darkens the border and adds a Raised fill.

Two layers float above the sheet and carry a soft shadow: the side panel (a left-cast shadow, `-12px 0 32px -12px` at 16% ink) and the confirm dialog. Nothing else does.

### Named Rules
**The Two Planes Rule.** Frame and sheet are the only planes. Do not add a third with cards on tinted panels or stacked shadows. The side panel and the confirm dialog are the only floating layers.

## Shapes

Small, even radii. 6px on buttons and inputs, 8px on cards and nav items, 16px on the sheet, full on pills and switches. Borders are 1px in Border; the lighter Rule divides rows inside a list. Timeline bars are 8px tall with full radius.

## Components

### Buttons
Tactile and calm: flat, compact, and pressed to 0.96 scale on click.
- **Shape:** gently rounded (6px).
- **Primary:** Ink Button fill with white text, 32px tall, 12px side padding. Hover drops to 85% opacity.
- **Outline:** white with a 1px Input Stroke border; hover fills Raised.
- **Secondary:** Active fill. **Ghost:** no fill until hover.
- **Destructive:** white with a 40% red border and red text; hover takes the full red border and the pale negative fill. Never a solid red button.
- **Focus:** a 2px Signal Teal ring with 1px offset.
- **Sizes:** 24px, 28px, 32px (default) and 36px.

### Chips (state pills)
- **Style:** full radius, 12px medium text, 2px by 8px padding, pale fill with dark ink of the same hue.
- **State:** positive, warning, negative and neutral. "Stuck" on a board card is a negative pill.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** Sheet, with a 1px Border and `shadow-xs`.
- **Hover:** border goes to 20% ink and the fill to a faint Active. The whole card is the link.
- **Internal Padding:** 12px. Title on one line, `target #ticket · 3h ago` in mono and Muted Ink under it, cost right-aligned in a 56px slot.

### Navigation
- **Sidebar:** 36px items, 8px radius, a 16px lucide icon at 1.5 stroke in Muted Ink, label in Ink at 80%. The active item has an Active fill that slides between items.
- **Breadcrumb:** in the top bar, Muted Ink links separated by `/`, the current page in medium Ink.
- **Tabs:** underline tabs on a full-width 1px rule; the active tab takes a 2px Signal Teal line.

### Switches
- 32px by 18px, full radius. Checked fills Ink Button, unchecked fills Switch Off, with a white thumb.
- Turning on a switch that lets the factory merge (Auto merge, Apply) asks first in the confirm dialog. Turning any switch off never asks.
- A target whose switch is off because the all-targets row is off shows "Off (all targets)" in Muted Ink instead of a switch.

### Side panel
Detail lives in a panel that slides in from the right edge, never in a centred modal.
- **Shape:** full height, up to 640px wide (full width on a phone), white with a 1px left border and the panel shadow. From 1024px the whole run page, title row included, moves left by the panel's width, and the panel narrows (`min(640px, 100vw - 608px)`) so the step list keeps about 340px.
- **Header:** the title (16px, 600) with its pills, an optional muted line, and a ghost close button at the top right (44px on a phone, 32px from 640px), over a 1px rule. 24px side padding.
- **Body:** one scrolling column, 24px padding, sections 32px apart, each with the shared heading at 14px.
- **Behaviour:** non-modal. No overlay; the page behind stays live, and a click on another row swaps the content. Opening moves focus to the panel title; Esc and the close button close it and return focus to the row. It slides in over 300ms with the control ease and respects reduced motion. The open item is in the URL (`?step=<id>`).

### Confirm dialog
The only centred dialog, for a yes-or-no decision such as Stop, Resume or Restart.
- 448px wide, 16px radius, 24px padding, over a 20% ink overlay.
- Title (16px, 600), one muted sentence, then Cancel (outline) and the action on the right. Focus starts on Cancel.

### Run timeline (signature)
The production line on the run page. One row per step: name in a 160px column, an 8px bar on a Raised track placed by start time and length, then duration, pills and cost in fixed right-aligned slots. A finished step's bar is ink at 70%, the live one is Signal Teal, a failed or stuck one is red. A click on the row opens the step in the side panel; the open row keeps an Active fill. On a phone the row takes two lines: name and pills, then bar, duration and cost. A step not reached shows its name in Muted Ink on an empty track, at the same row height. A live step shows its cost as a muted dash until it reports usage.

## Do's and Don'ts

### Do:
- **Do** keep Signal Teal for live data, the active tab, the mark and focus only.
- **Do** open every screen with the page title row and a one-line finding in Muted Ink.
- **Do** put numbers in fixed-width, right-aligned slots with tabular figures.
- **Do** set repo names, ticket numbers and logs in Plex Mono.
- **Do** give every control the 120ms fade and the 0.96 press, and respect reduced motion.

### Don't:
- **Don't** add a second hue, or a color without both a light and a dark value, without updating this file.
- **Don't** use solid red fills; red is text, a stroke, a bar or a pale pill.
- **Don't** add shadows beyond `shadow-xs` on cards, or use shadow on hover.
- **Don't** put cards on tinted panels inside the sheet; there are two planes.
- **Don't** open detail in a centred modal; use the side panel. Centred dialogs are only for yes-or-no confirms.
