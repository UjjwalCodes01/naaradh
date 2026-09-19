# Naaradh — website design brief

**For:** the designer of naaradh.com · **From:** Naaradh (founder) · **Date:** 19 September 2026
**Scope:** the public website only. The logged-in dashboard and the Shopify app are already built
and are not part of this job (§8).

---

## 1. What Naaradh is, in one minute

Naaradh is an **AI voice agent for online shops in India**. It does two things on the phone, in
Hindi, English or a mix of both:

1. **Answers the shop's phone line, 24/7.** A customer rings the number on the shop's website. The
   AI picks up, says it is an AI and that the call is recorded, checks who is calling, and answers
   "where is my order", "can I change the address", "what is your return policy". It can cancel an
   unshipped cash-on-delivery order after asking twice, raise a ticket for anything it may not do,
   and pass the call to a human during the shop's working hours.
2. **Calls customers to confirm cash-on-delivery orders before they ship.** In India most online
   orders are paid in cash at the door, and a large share are refused when the courier arrives —
   the shop pays shipping both ways and gets the goods back. A short confirmation call before
   dispatch removes much of that loss.

It also calls people who abandoned a cart (only if they ticked a consent box), asks for feedback
after delivery, and reminds people about appointments.

**The name:** Narada (नारद) is the messenger sage of Indian mythology — the one who carries word
between worlds. Naaradh is the messenger for a shop.

## 2. Who the website is talking to

| Visitor | What they want in the first 10 seconds | Where they are |
|---|---|---|
| **The buyer: owner or operations manager of an Indian online brand** (fashion, beauty, home; 10–500 orders a day; on Shopify or WooCommerce) | "What is this, does it work for my shop, what does it cost, can I trust it with my customers?" | Mostly a mid-range Android phone, 4G, often at 11 p.m. |
| **A customer who received a call** — possibly annoyed | "Who called me, and how do I stop it?" | Phone, in a hurry, maybe angry |
| **Reviewers and lawyers** — Shopify's app review team, a merchant's legal adviser, a telecom operator | "Are the privacy policy, terms, data-processing agreement and grievance contact real and reachable?" | Desktop |

The second and third are not decoration: Indian telecom rules and Shopify's app review both
require that the opt-out page and the legal pages exist, are easy to find and work without login.

## 3. What makes this different — and what the design must carry

Every competitor sells "AI calls". Naaradh's actual pitch is the opposite: **a product that
refuses to call when it shouldn't.** India's telecom regulator can blacklist a business over a
handful of complaints, and the shop — not the vendor — carries the liability. Naaradh enforces the
rules itself: calls only between 9 a.m. and 9 p.m., never without a recorded consent for marketing
calls, checks the national do-not-disturb registry, announces on every call that it is an AI and
that the call is recorded, and stops calling anyone who asks it to.

So the design should feel like: **calm, exact, trustworthy, a little serious.** A merchant is
handing over their customers' phone numbers and their brand's voice.

Please avoid: glowing purple gradients, robot faces, brains, waveform clichés, "10x your revenue"
energy, countdown timers, fake urgency. Nothing that looks like a growth-hacking tool.

Nearer the mark: a well-made piece of business infrastructure — think a bank's payment product or
a good logistics dashboard — but warmer, and clearly Indian without resorting to marigolds and
rickshaws.

## 4. Honesty constraints (these are hard)

We are pre-launch: **no customers, no logos, no testimonials, no "trusted by 500 stores".** The
design must look complete and credible with **zero social proof**, and have obvious places to add
it later (a logo strip, a case-study card, a review quote).

Nothing on the site may claim a result we cannot evidence. No invented percentages. Where we want
to talk about savings, it is framed as "what this typically costs you" arithmetic the visitor can
check, not as a promise.

## 5. Pages to design

All of these exist as plain, unstyled pages today; you are giving them a design.

| Page | Purpose | Notes for you |
|---|---|---|
| **Home** (`/`) | Explain it in 10 seconds; two products (support line, order confirmation); how it works; why compliance matters; what it costs; call to action | The single most important screen. Needs a mobile-first hero, and an honest "how it works" that survives without screenshots — we have a dashboard we can screenshot, no call recordings we can publish |
| **Pricing** (`/pricing`) | Two plan tables: outbound (billed per confirmed outcome) and the support line (billed per connected minute) | Numbers come live from the product — design a table that can grow a column or a row. Current outbound: ₹1,999 / ₹4,999 / ₹12,999 a month including 150 / 500 / 1,500 outcomes, then ₹10 / ₹8 / ₹6 each. Support line: ₹2,499 / ₹6,999 / ₹14,999 including 500 / 1,500 / 4,000 minutes, then ₹6 / ₹5 / ₹4. Plus "Enterprise — talk to us". Must state: prices exclude GST; you set a spending cap; unanswered and unclear calls are never billed |
| **Do not call** (`/do-not-call`) | A member of the public enters their number and is never called again, by any shop on Naaradh | **Regulatory obligation.** One field, one button, works on a slow phone, no login, no marketing around it, findable from every page footer and legible to someone who is annoyed. Also needs a "report an unwanted call" path |
| **Sign in** (`/login`) | A merchant enters their email and gets a sign-in link | No passwords anywhere. Design the sent/expired/invalid states |
| **Legal pages** (`/privacy`, `/terms`, `/dpa`, `/aup`, `/security`, `/subprocessors`, `/cookies`, `/refunds`, `/contact`, `/grievance`) | Ten long text documents | One readable long-form template: table of contents, headings, tables, "last updated", print-friendly. Serious, not decorated |
| **404 and error** | | Keep them plain and useful |

**Two pages we do not have yet and probably want** — tell us if you agree:
- **How it works / product detail**, if Home cannot carry both products without becoming a wall.
- **For developers**, a short page pointing at the API documentation (we have an OpenAPI reference).

## 6. What the site must actually achieve

In priority order:

1. A Shopify merchant understands the product and **installs the app** (button goes to the Shopify
   App Store listing) or **books a call** with us.
2. A non-Shopify merchant **asks for access** (a short form: shop name, website, orders a month,
   phone).
3. A worried visitor finds **pricing and the legal pages** without searching.
4. A member of the public opts out **in under a minute**.

There is no self-serve signup: every merchant is onboarded by us at this stage. So the primary
call to action is *install* or *talk to us*, never "create an account".

## 7. Practical constraints

- **Built in Next.js with Tailwind CSS.** Please design with a token system — a small colour
  palette, a type scale, a spacing scale, and reusable components (button, card, table, form
  field, banner, footer) with their states. One-off pixel values are expensive for us to build.
- **Mobile first, from 360 px wide.** Most Indian traffic is a mid-range Android on 4G.
- **Fast.** Aim for a hero that renders with no more than one image. Prefer SVG and CSS to large
  photography. At most two web fonts.
- **The type must support Devanagari (Hindi).** Product copy on the site is English for now, but we
  will add Hindi, and the product itself speaks Hindi.
- **Accessibility: WCAG 2.1 AA.** Real contrast, visible focus rings, labels on every field, works
  at 200% zoom. Legal and opt-out pages especially.
- **Dark mode: not required.** If you provide it, it must be a token swap, not a second design.

## 8. Explicitly out of scope

- **The merchant dashboard** (what a merchant sees after signing in) — already built, functional
  and plain. We may ask you to restyle it later; not now.
- **The Shopify embedded app** — Shopify requires its own design system (Polaris) inside their
  admin; it cannot look like our site.
- **The staff console** — internal, ugly on purpose, behind Google sign-in.

## 9. What we will give you

- All the copy for every page (we write it; you may rewrite for rhythm, but claims and legal
  wording must come back to us for approval).
- Live pricing numbers, and screenshots of the real dashboard if you want product imagery.
- The ten legal documents (drafts, under review by counsel).
- Brand: the name, the story above, and the domain. **We have no logo, colour palette or
  typeface yet** — if you can propose them, say so and quote for it separately; otherwise we will
  bring a logo and you design around it.

## 10. What we need back

1. A Figma file with: a design system page (colour, type, spacing, components with states),
   desktop and mobile frames for every page in §5, and the empty/loading/error/success states for
   the two forms (opt-out, sign-in).
2. Favicon and app icon, and an Open Graph image template for link previews.
3. A short handoff note: font files or Google Fonts names, icon set, and anything that must be an
   image rather than CSS.
4. Editable source for anything illustrated.

Please flag anything in this brief that fights the design rather than working around it quietly —
particularly §4 (no social proof) and the do-not-call page, which we cannot compromise on.

---

**Questions to us, any time.** The one thing we care about more than beauty: a merchant should
finish the homepage believing that this company will not get their phone number blacklisted.
