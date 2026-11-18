# Reproductor visual system

Source: `public/styles.css`.

## Colors

| Token | Value | Usage | Source |
|---|---|---|---|
| `--bg` | `#000` | Page background | `public/styles.css` |
| `--bg-deep` | `#000` | Deep background | `public/styles.css` |
| `--panel` | `rgba(10, 10, 12, 0.9)` | Panel surface | `public/styles.css` |
| `--panel-strong` | `rgba(16, 16, 18, 0.92)` | Strong panel surface | `public/styles.css` |
| `--line` | `rgba(255, 255, 255, 0.38)` | Borders | `public/styles.css` |
| `--line-soft` | `rgba(255, 255, 255, 0.16)` | Soft borders | `public/styles.css` |
| `--glow` | `rgba(255, 255, 255, 0.28)` | Focus glow | `public/styles.css` |
| `--text` | `#f6f7fb` | Primary text | `public/styles.css` |
| `--muted` | `#aeb6c5` | Secondary text | `public/styles.css` |
| `--accent` | `#dfefff` | Emphasis | `public/styles.css` |
| `--accent-strong` | `#ffffff` | Focus/emphasis | `public/styles.css` |
| `--danger` | `#ff9a9a` | Destructive status | `public/styles.css` |
| `--success` | `#a8e8a0` | Success status | `public/styles.css` |

## Typography

| Rule | Value | Source |
|---|---|---|
| Font family | `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `public/styles.css` |
| Base contrast | `--text` on `--bg` | `public/styles.css` |

## Spacing and shape

| Rule | Value | Source |
|---|---|---|
| App padding | `clamp(0.55rem, 1.1vw, 1.2rem)` / `clamp(0.8rem, 1.45vw, 1.6rem)` | `public/styles.css` |
| Panel radius | `1rem` | `public/styles.css` |
| Control radius | `0.75rem` | `public/styles.css` |
| Compact action height | `2.75rem` | `public/styles.css` |

## Component rules

Panels are dark translucent surfaces with soft white borders. Buttons use a visible `2px` focus ring and glow. Transport controls are icon-only by default; labels expand only when `(hover: hover) and (pointer: fine)` is true. Honor reduced motion; status color supplements readable text.
