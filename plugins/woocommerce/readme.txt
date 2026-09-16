=== Naaradh — AI calls for WooCommerce ===
Contributors: naaradh
Tags: woocommerce, cod, abandoned cart, voice, calls
Requires at least: 6.4
Tested up to: 6.7
Requires PHP: 8.1
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Confirm cash-on-delivery orders, recover abandoned carts and answer your support line with an AI voice agent.

== Description ==

Naaradh calls your customers so you do not have to: it confirms cash-on-delivery orders before
you ship them, calls customers who left a cart (only those who agreed to be called), and answers
your support line.

This plugin is the connector. It does four things, all from your server:

* adds a call-consent checkbox at checkout and stores which wording the shopper agreed to;
* reports cash-on-delivery orders so Naaradh can place a confirmation call;
* reports every order so the support-line agent can answer questions about it;
* reports carts (with consent) and closes them when the order is placed.

Call results come back as order notes. The plugin never cancels or edits an order by itself.

**This plugin sends data to a third-party service.** With an API key configured, it sends to
`api.naaradh.com`: your order id and number, the billing phone number and first name, the
delivery postcode, the payment method, order status, totals, currency and a short item summary,
and for carts the same fields plus the cart total and item summary. It does not send email
addresses or full addresses. Naaradh's terms: https://naaradh.com/terms — privacy policy:
https://naaradh.com/privacy — data processing agreement: https://naaradh.com/dpa.

Naaradh places calls under India's TRAI/TCCCPR rules: a calling window of 09:00–21:00 in the
customer's time zone, a do-not-disturb check, and a recorded consent for anything promotional.
Customers who ask not to be called are never called again.

== Installation ==

1. Install and activate the plugin.
2. In your Naaradh dashboard, create an API key with the scopes `intents:create`, `orders:write`
   and `carts:write`.
3. WooCommerce → Settings → Naaradh: paste the key, choose which calls you want, and copy the
   consent wording and its version from the dashboard.
4. In Naaradh, register a webhook pointing at the URL shown on that settings page, and paste its
   signing secret back into the settings.

== Frequently Asked Questions ==

= Does it call every customer? =

No. Order confirmation calls go to cash-on-delivery orders. Cart recovery calls go only to
shoppers who ticked the consent box, at most one call per number per week.

= What if a customer says "cancel my order"? =

You get an order note saying so. The plugin never cancels the order itself.

= Does it need a phone number? =

Yes. If your checkout hides the phone field, nothing can be called, and the settings page says so.

== Changelog ==

= 0.1.0 =
* First release: consent checkbox, COD confirmation calls, order cache, cart recovery, result notes.
