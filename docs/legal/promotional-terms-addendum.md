# Terms addendum — promotional calling `[LEGAL — draft, then lawyer]`

**Status:** draft for counsel. Nothing here is in force. It exists so that the product's
behaviour and the contract say the same thing when promotional calling goes live (P4-BILL-1,
ADR-0010). Open questions: Q-08 (wording), Q-21 (who sends the link), Q-23 (DLT templates for
voice), Q-24 (pricing a recovery).

## 1. What the merchant is buying

Naaradh places, on the merchant's instruction, promotional voice calls of these kinds:

| Use case | When | Limits built into the product |
|---|---|---|
| Abandoned checkout recovery | 45 minutes after a checkout goes quiet, never later than 24 hours after it started | one call per checkout; one promotional call per phone per merchant per 7 days |
| Post-delivery feedback | 24 to 72 hours after delivery is reported | one call per order; skipped for cancelled, refunded, returned and test orders |

Calls are placed only 09:00–21:00 in the recipient's time zone, only to numbers with a live
consent, only with a script the merchant approved, and only while the merchant's DLT principal
entity is linked to Naaradh as its registered telemarketer.

## 2. The merchant's warranties (in addition to the main Terms)

1. The consent box Naaradh provides (checkout extension or cart block) is shown unticked, its
   wording is not altered, and no other mechanism is represented to shoppers as consent to be
   called.
2. The merchant does not upload, import or otherwise introduce phone numbers that did not tick
   that box (E-71: purchased lists are an AUP breach and grounds for suspension).
3. The merchant is the Principal Entity for its own DLT registrations and for every content
   template used on its calls, and the template ids it enters in Naaradh are its own registered
   templates (Q-23).
4. The merchant answers complaints from its customers and cooperates with any TRAI or telecom
   provider enquiry within the timelines in the main Terms.

## 3. What Naaradh does and does not send

Naaradh places **voice calls only**. It sends no SMS and no WhatsApp message (Q-21). Where a
customer asks on a call for their checkout link, Naaradh reports that request to the merchant
(`checkout.recovery_requested`) and the merchant sends the link with its own messaging, under
its own sender registration.

## 4. Charges

**A recovered cart is not a billable outcome.** The billable set is unchanged from the main
Terms: `confirmed`, `confirmed_with_changes`, `cancelled`, `rescheduled`, `booked` on a
human-answered call. Promotional outcomes — including "the customer said they would complete the
order" — are **not charged**.

Naaradh reports, for the merchant's own measurement only, orders placed within the merchant's
attribution window (default 24 hours, configurable 1–72) after an abandoned-checkout call that
reached a person, matched by the same checkout or the same phone, last touch, one per order, and
withdrawn if the order is later cancelled. This reporting is a measurement, not a
representation that the call caused the order, and is not a basis for any charge. `[DECISION —
Q-24: if recoveries are ever charged, the price, the attribution rule and this clause change
together, recorded in an ADR and re-accepted by the merchant.]`

## 5. Suspension specific to promotional calling

A complaint attributed to a promotional call suspends **promotional** calling for that merchant
immediately, without notice, until Naaradh has reviewed the complaint, the consent evidence and
the script. Order confirmation calls and the merchant's support line are unaffected. Repeated
complaints suspend all calling under the main Terms (3 in 10 days).

## 6. Data

Abandoned-checkout data (hashed phone, first name, cart summary and value, timestamps) is
processed under the DPA for the sole purpose of the recovery call, and the phone link is deleted
after 30 days. Shopify marketing and SMS-consent fields are not read. A shopper who unticks the
box, asks to be removed on a call, or files a do-not-call request is suppressed for every
merchant on Naaradh.
