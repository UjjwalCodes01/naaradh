# Client libraries and signature verification

Naaradh publishes an OpenAPI 3.1 document and no hand-written SDKs (P5-API-1). Generate a client
in your language from the document, or use plain HTTP — the API is small enough that many teams
do.

```bash
# the document (no API key needed)
curl -o naaradh.json https://api.naaradh.com/v1/openapi.json

# TypeScript types only (no runtime, no codegen server)
npx openapi-typescript naaradh.json -o naaradh.d.ts

# a full client, if you want one
npx @hey-api/openapi-ts -i naaradh.json -o src/naaradh    # TypeScript
openapi-generator-cli generate -i naaradh.json -g python -o ./naaradh-python
```

Pin the document you generated from: an added field is safe, but regenerate deliberately, on
your own schedule.

## Three rules whatever you generate

1. **`Idempotency-Key` on every POST.** The same key returns the first response instead of
   making a second call. Use your own stable id (order id, lead id), never a random per-attempt
   value.
2. **`gated` is not an error.** `POST /v1/intents` answers `202` with `status: "gated"` and a
   `reason` when the compliance layer refused. Show the `explanation`; do not retry it.
3. **Never log the phone number you sent.** Naaradh stores it hashed and encrypted and returns it
   only masked; a log line in your app is the weakest link.

## Verifying a webhook signature

Header: `X-Naaradh-Signature: t=<unix seconds>,v1=<hex>` over `t + "." + raw_body`. Reject when
the timestamp is more than 300 seconds old, compare in constant time, and verify **before**
parsing the body.

### Node (Express, raw body)

```js
import crypto from 'node:crypto';

app.post('/naaradh', express.raw({ type: 'application/json' }), (req, res) => {
  const header = String(req.get('x-naaradh-signature') ?? '');
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return res.sendStatus(401);
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return res.sendStatus(401);
  const expected = crypto
    .createHmac('sha256', process.env.NAARADH_WEBHOOK_SECRET)
    .update(`${m[1]}.${req.body.toString('utf8')}`)
    .digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8'));
  // dedupe on event.id — delivery is at-least-once
  res.sendStatus(200);
});
```

### Python (Flask)

```python
import hmac, hashlib, re, time
from flask import request, abort

def verify(secret: str) -> dict:
    m = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", request.headers.get("X-Naaradh-Signature", ""))
    if not m or abs(time.time() - int(m.group(1))) > 300:
        abort(401)
    raw = request.get_data()                      # bytes, before any parsing
    expected = hmac.new(secret.encode(), f"{m.group(1)}.".encode() + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, m.group(2)):
        abort(401)
    return request.get_json()
```

### PHP

```php
$header = $_SERVER['HTTP_X_NAARADH_SIGNATURE'] ?? '';
if ( ! preg_match( '/^t=(\d+),v1=([0-9a-f]{64})$/', $header, $m ) ) { http_response_code( 401 ); exit; }
if ( abs( time() - (int) $m[1] ) > 300 ) { http_response_code( 401 ); exit; }
$raw      = file_get_contents( 'php://input' );
$expected = hash_hmac( 'sha256', $m[1] . '.' . $raw, $secret );
if ( ! hash_equals( $expected, $m[2] ) ) { http_response_code( 401 ); exit; }
$event = json_decode( $raw, true );
```

The WooCommerce plugin in this repository (`plugins/woocommerce`) is a working example of the
PHP side, including deduping on the event id.
