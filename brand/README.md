# bookii — logo system

Typeface: **Playfair Display** (SIL Open Font License) — the Didone that matches the
original wordmark. Letterforms here are **outlined to vectors**, so no font file is needed
to display the logo.

Colors: ink `#1A1E2E` · cobalt `#2B3EE5`

## Contents
- `wordmark/` — primary (ink + cobalt dot), all-ink mono, white (for dark), white mono
- `mark/` — the b·dot mark: rounded tile, full-bleed, maskable, and tile-less versions
  (`mark-plain-dark` = b·dot for light backgrounds, `mark-plain-light` = for dark)
- `lockup/` — horizontal & stacked, each in standard and reversed (for dark backgrounds)
- `favicon/` — drop-in web set: `.ico`, `.svg`, PNGs, apple-touch, maskable,
  `site.webmanifest`, `head-snippet.html`
- `png/` — ready-to-use raster exports (2× density)
- `sources/` — extra editable SVG masters

## Clear space & sizing
Keep clear space around the logo equal to the height of the mark's dot. Minimum wordmark
width ~120px; below that, use the mark alone. Favicon deploy: copy `favicon/` files to web
root, paste `head-snippet.html` into `<head>`, hard-refresh.

## Note
Playfair Display is a very close match to the original wordmark. If your wordmark uses a
licensed cut (e.g. a specific Bodoni/Didot), send the font or the vector and I'll re-outline
from that exact face — the geometry/spacing here will carry over.
