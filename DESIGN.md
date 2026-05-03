# Design System: Refresh

## 1. Visual Theme & Atmosphere

Refresh uses a daily-app balanced interface: calm, precise, and operational.
The visual language should feel native to Chrome, with premium restraint rather
than decorative effects. Density is medium, variance is controlled, and motion
is subtle CSS feedback only.

## 2. Color Palette & Roles

- **Canvas Mist** (#F8FAFD) — popup and options background.
- **Pure Surface** (#FFFFFF) — primary command surfaces and grouped rows.
- **Charcoal Ink** (#202124) — primary text and strong numerals.
- **Muted Graphite** (#5F6368) — secondary text, icon strokes, labels.
- **Divider Cloud** (#DFE3EB) — borders and structural dividers.
- **Google Blue** (#1A73E8) — the single accent for active states, focus rings,
  progress, controls, and extension identity.

## 3. Typography Rules

- **Display:** Google Sans or Geist-like sans-serif, compact and weight-led.
- **Body:** Google Sans, Roboto, Arial, system sans fallback.
- **Numbers:** Tabular numerals for countdowns, timestamps, and session stats.
- **Banned:** Neon gradients, pure black, purple glows, emojis, and decorative
  pseudo-technical labels.

## 4. Icon System

- Extension icon: rounded square, Google Blue accent family, white refresh mark,
  and simplified page cue. It must remain readable at 16px.
- Popup icons: inline SVG only, 24px viewBox, rounded caps and joins, `1.9px`
  stroke, no CSS-drawn pseudo icons for semantic controls.
- Decorative history markers may use simple dots, not complex hand-drawn shapes.
- Icons should never compete with the countdown ring; they support scanning.

## 5. Component Stylings

- **Countdown ring:** Primary command object, circular, status-colored stroke,
  tactile hover and active feedback.
- **Buttons:** Material-like radius, flat fills, no outer glow.
- **Grouped rows:** Use dividers and white surfaces instead of stacked admin
  cards.
- **Inputs:** Visible labels, clear focus rings, no floating labels.

## 6. Motion & Interaction

Use spring-like cubic easing. Animate only color, opacity, transform, and stroke
offset. Respect `prefers-reduced-motion`.

## 7. Anti-Patterns

Never use neon effects, purple-blue AI gradients, pure black, emojis, generic
three-card marketing layouts, custom cursors, overlapping elements, or icons
drawn from fragile rotated CSS borders where SVG is available.
