# Reproductor visual system

Source: `public/styles.css`.

## Colors
- `--bg`, `--bg-deep`: `#000` — page background.
- `--panel`: `rgba(10, 10, 12, 0.9)`; `--panel-strong`: `rgba(16, 16, 18, 0.92)` — surfaces.
- `--text`: `#f6f7fb`; `--muted`: `#aeb6c5` — text.
- `--accent`: `#dfefff`; `--accent-strong`: `#ffffff` — emphasis/focus.
- `--success`: `#a8e8a0`; `--danger`: `#ff9a9a` — status.
- `--line`, `--line-soft`, `--glow` — borders and focus glow.

## Typography
`Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

## Spacing and shape
Panels use responsive padding around `0.75rem–1rem`, `1rem` radius, soft white borders and dark shadows. Controls use `0.75rem` radius and visible white focus rings.

## Component rules
Progress belongs inside one existing meaningful panel, with a readable status label and ETA/elapsed text; color is supplementary to text. Honor reduced motion; do not use indefinite decorative animation.
