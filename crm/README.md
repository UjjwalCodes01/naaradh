# crm

CRM lead sources behind one port: **Zoho CRM** and **HubSpot** (tickets P5-CRM-1 / P5-CRM-2).

**Why it exists:** a merchant whose leads arrive in a CRM wants the new ones called back while
they are still warm. Their CRM can already POST somewhere when a lead is created — this is the
somewhere.

**What lives here:** authenticating the request (`verify.ts`) and reading the lead out of the body
(`parse.ts`). Nothing else. The lead becomes a call through the same `createIntent()` the public
API uses, so the use case must be enabled on the account, the number is normalised and hashed, two
deliveries of the same lead merge into one call (E-42), and the compliance gate decides whether and
when it goes out. A CRM cannot make us dial anything the API could not.

## Consent

`lead_callback` is a **service** purpose (`compliance/src/constants.ts`), not a promotional one:
the person filled in a form asking to be called. So no consent row is required — and everything
else still applies, including suppressions, the do-not-call list and the calling window. Where the
merchant maps a consent field, it is recorded on the intent as evidence, which is what makes that
lead reachable for a *promotional* call later. An unmapped field is never guessed at.

## How a merchant is connected

1. The owner connects the CRM in **Dashboard → Developers → Connected providers**.
2. They paste the URL into a **workflow webhook** in their CRM (Zoho: Workflow Rules → Webhook;
   HubSpot: Workflow → Send a webhook) and choose which fields to send.
3. A lead lands, and the intents worker creates the callback.

```
https://hooks.naaradh.com/crm/<provider>/<tenant_id>.<tag>
```

The URL is the credential: minted from `PROVIDER_WEBHOOK_KEY`, naming exactly one tenant and one
provider, checked in constant time before the body is parsed. It shares that key with the
one-click-checkout URLs but not its value — each area is domain-separated, so a leaked CRM URL is
not an OCC URL.

**Signing is optional but real.** Neither CRM signs a workflow webhook in a way we can verify per
merchant (Zoho sends no signature; HubSpot signs with the *app's* client secret, which a merchant
on a private app does not share with us). A merchant whose CRM can add headers should send
`x-naaradh-signature` — hex or base64 HMAC-SHA256 of the raw body, keyed with the secret shown
beside the URL — and can then set the integration to require it. A signature that is present and
wrong is always refused, under either setting.

## Field names

Both CRMs let the merchant choose which fields the webhook sends and what to call them, so this
reads the body **by name**: each CRM's usual names first (`Phone`, `First_Name`, `Lead_Source` for
Zoho; `phone`, `firstname`, `hs_analytics_source` for HubSpot, including HubSpot's
`properties: { field: { value } }` shape), then any overrides the merchant has set in
`integrations.metadata.crm.fields`.

One thing is never guessed: **the phone number**. A lead with no readable phone is refused with an
error naming the fields we looked for, so the answer to "why didn't my lead come through?" is in
the response the CRM already logged, not in ours.
