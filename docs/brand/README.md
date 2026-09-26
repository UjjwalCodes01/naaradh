# Brand assets

The source art is in `source/` (2000 × 2000 PNGs, as supplied). Everything the product uses is
derived from those three files and lives in `web/public/brand/` or `web/src/app/`.

## What is where

| File | Used by |
|---|---|
| `web/public/brand/mark.png` | The N mark, transparent. Header logo, dashboard sidebar — anywhere on a light surface. |
| `web/public/brand/tile.png` | The mark on its dark green rounded square, transparent corners. The footer and anywhere on a dark surface, where the plain mark would disappear. |
| `web/public/brand/lockup.png` | Mark + name + tagline, flattened on brand cream. Social previews, decks, anything printed. |
| `web/src/app/icon.png` | The favicon (Next.js App Router convention — no `<link>` tag needed). |
| `web/src/app/apple-icon.png` | The iOS home-screen icon. |
| `web/src/app/opengraph-image.png` | The link preview, 1200 × 630. Next emits the `og:image` tags automatically. |
| `shopify-listing-icon-1200.png` | For the Shopify App Store listing (uploaded by hand in the Partner Dashboard, go-live 04). |
| `truecaller-icon-200.png` | For Bolna's Truecaller verification, which asks for a 200 × 200 PNG brand icon (go-live 03). |

## How they were made

Backgrounds were removed by **flooding inward from the edges**, never by keying a colour: the
mark contains a near-white ribbon through the N that a global key would have punched a hole in.

Two of the three needed something other than a flood:

- **The tile** is a rounded square whose bottom edge is only a few levels above the black
  surround, so a flood ate into it. It is masked with a rounded rectangle instead — clean corners,
  nothing chewed.
- **The lockup** is flat dark art on flat near-white, and the counters inside `a`, `d` and `o` are
  background enclosed by letterforms, which a flood from the edges can never reach. Cutting them
  out one by one would have risked the ribbon, so the background is **recoloured to brand cream**
  (`#f5f2ea`) instead of removed. It is only ever shown on cream, so there is no halo and no white
  blob inside a letter.

To regenerate after new art lands: replace the files in `source/`, then redo the three steps
above. There is no script in the repo for this — it is a handful of one-off image operations, not
something the build does, and adding an image-processing dependency to a Node service to do it
once would be the wrong trade.

## Using them

The name is **live text**, not part of the image, everywhere in the product (`Logo` in
`web/src/components/site/ui.tsx`). It scales with the layout, it is selectable, and a screen
reader reads it — so the images are decorative and carry an empty `alt`.

Two places deliberately have **no** logo:

- **Transactional email** (`notify/`) is plain HTML with a text signature. An image in an email
  needs an absolute URL, is blocked by default in many clients, and doubles as a read receipt.
  The text footer says who sent it, which is what matters.
- **The staff console** is behind IAP and internal. Shipping a binary asset into that image for a
  browser-tab icon is not worth the bytes.
