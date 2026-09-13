/** Liveness for the load balancer and deploy smoke checks. No Shopify or database call. */
export const loader = () => Response.json({ ok: true });
