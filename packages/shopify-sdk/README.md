# @naaradh/shopify-sdk

Typed Admin **GraphQL** operations (codegen, pinned `api_version`), webhook payload parsers,
order write-back helpers (tags / note / metafields), and Billing API helpers.

**Status:** not implemented — tickets **P1-SHOP-1**, **P1-SHOP-2**, **P2-SHOP-3**.

- REST Admin API is not used. New public apps are GraphQL-first.
- Adding a scope requires: `shopify.app.toml` + `scopes.ts` + `docs/shopify/pcd-justification.md`
  + an ADR. Scopes are reviewed for minimisation.
- `gateways.ts` normalises `paymentGatewayNames` for COD detection across Shopify manual/COD and
  the Indian one-click providers (GoKwik, Shiprocket, Razorpay Magic, Cashfree). An unknown gateway
  means **not COD** — no call, plus telemetry (E-45). Guessing here dials prepaid customers.
- Protected customer data **Level 2** is required because the app reads phone and name. Until it is
  approved, those fields arrive as `null` and the gate must return `no_phone` rather than crash (E-43).
