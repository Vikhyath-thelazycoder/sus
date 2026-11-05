# Design — SustainIQ

Visual and interaction direction (spec §20.6, §26–27).

## Visual direction

**Calm, minimal, focused.** It should feel like a quiet reading room for research: warm paper-like background, one muted sage-green accent (sustainability without clichés), generous whitespace, and the answer text as the hero.
- **Reason:** users read long, technical answers and check sources; calm visuals reduce fatigue and make citations easy to spot.
- **Avoid:** bright gradients, glowing "AI" effects, leaf/planet clipart, heavy shadows, more than one accent colour, cluttered toolbars, chat bubbles for long answers (use a document-style answer column instead).
- **Peers for the feel (not to copy):** research and answer tools such as Perplexity, Claude and Elicit.

## Component principles

- Few components, reused everywhere: `Button`, `IconButton`, `Input`, `Card`, `Badge`, `Sheet` (side panel / bottom sheet), `Drawer`, `Skeleton`, `Toast`.
- The answer is plain text on the page (no bubble); the user question sits above it in muted text.
- Citations are small superscript-style pills `[2]` in the accent colour; the panel is the only place details appear.
- One primary action per screen (send, upload).

## Typography

- **Inter** (self-hosted, variable). Optional serif for paper titles only: **Source Serif 4** (self-hosted).
- Scale (rem): 0.8125 caption · 0.875 small · 1.0625 body (17 px) · 1.25 h3 · 1.5 h2 · 2 h1.
- Line height 1.6 for answers, 1.4 for UI. Answer column max ~68 characters per line (≈ 720 px).

## Color

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#FAF8F3` | `#161815` | Page |
| `--surface` | `#FFFFFF` | `#1E211D` | Cards, panel |
| `--text` | `#2B2B28` | `#E8E6DF` | Body |
| `--muted` | `#6B6B63` | `#9A988F` | Secondary text |
| `--accent` | `#5E7F62` | `#8DB290` | Citations, primary button, focus |
| `--accent-soft` | `#E6EEE6` | `#24302A` | Highlighted passage |
| `--border` | `#E7E3D9` | `#2C302B` | Dividers |
| `--danger` | `#A4473D` | `#E08A7F` | Errors only |

Contrast target: WCAG AA (4.5:1 for text, 3:1 for UI elements); verified in T-5.6. Dark mode follows the system setting, with a toggle.

## Spacing

4 px base: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64. Radius: 8 (controls), 12 (cards, panel). Layout: sidebar 260 px · answer column ≤ 720 px · citation panel 380 px.

## Responsive rules

| Width | Layout |
|---|---|
| ≥ 1280 px | Sidebar + answer column + citation panel side by side |
| 1024–1279 px | Sidebar + column; citation panel overlays from the right |
| 768–1023 px | Sidebar collapses to icons; panel overlays |
| < 768 px | Sidebar becomes a drawer (☰); citation panel becomes a bottom sheet; input fixed at the bottom above the keyboard; 16 px side gutters; touch targets ≥ 44 px |

## Interaction

- **Streaming:** text appears as it is written; a subtle "Searching papers…" status first, then "Writing…".
- **Citations:** hover (desktop) highlights the pill; click/tap opens the panel; Esc or swipe down closes it.
- **States:** empty (greeting + 3–4 suggestions), loading (skeletons), "I couldn't find this in the papers" (with a suggestion to rephrase or upload), rate-limited ("You've asked a lot quickly — try again in a minute"), busy (free quota), errors (plain words, no codes), upload progress (Reading → Splitting → Indexing).
- **Feedback:** thumbs up/down under each answer; copy button.
- **Disclaimers:** small muted line under answers: "AI answers can be wrong. Check the cited sources."

## Accessibility

WCAG 2.2 AA: contrast, visible focus rings in the accent colour, full keyboard navigation (Tab to citations, Enter opens, Esc closes), ARIA labels on icon buttons, live region for streaming status, `prefers-reduced-motion` respected. Verified in T-5.6 with testing/accessibility checks.

## Motion

Minimal and functional only: panel/sheet slide 200 ms ease-out, drawer 200 ms, fade-in for new answers 150 ms. No decorative animation. All motion is disabled under `prefers-reduced-motion`.

## Reference sources

- Product direction: [../PROJECT_PLAN.md](../PROJECT_PLAN.md) §7.
- Peers for the feel: Perplexity, Claude, Elicit (feel only; no copying of layout, brand or assets).
- No client brand guidelines yet; ask on the Google Meet (logo, colours, name usage).
