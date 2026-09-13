/**
 * Local ESLint rules that enforce Naaradh invariants a reviewer would otherwise have to
 * catch by eye. Both rules here exist because of CLAUDE.md invariant 8: raw phone numbers
 * never appear in logs, error messages, analytics exports, or test fixtures committed to git.
 *
 * Scope note: these rules see TypeScript and JavaScript only. JSON fixtures, SQL, Markdown
 * and CSV are scanned by `pnpm lint:pii` (scripts/lint-pii.mjs), which covers every text
 * file in the repo.
 */

/**
 * E.164 prefixes of the reserved/fictitious ranges this repo uses for test data.
 * Must stay in sync with packages/shared/test/fake-phones.ts and scripts/lint-pii.mjs.
 */
const FAKE_PREFIXES = ['+916000000', '+121255501', '+447700900'];

/** A real-looking international number, or a bare Indian mobile (starts 6-9, 10 digits). */
const PHONE_PATTERNS = [/\+\d{10,15}/g, /\b[6-9]\d{9}\b/g];

/** Keys that carry a dialable number, a person, or call content. */
const PII_KEYS = new Set([
  'phone',
  'phone_e164',
  'phoneE164',
  'raw_phone',
  'rawPhone',
  'to_e164',
  'toE164',
  'from_e164',
  'fromE164',
  'msisdn',
  'mobile',
  'customer_name',
  'customerName',
  'name',
  'email',
  'address',
  'shipping_address',
  'shippingAddress',
  'transcript',
  'transcript_text',
  'recording_url',
  'recordingUrl',
  'recording_uri',
  'recordingUri',
  'otp',
  'aadhaar',
  'pan',
  'card',
  'upi',
]);

/** Safe by construction: hashed, masked, or an opaque reference. */
const PII_SAFE_KEYS = new Set([
  'phone_hash',
  'phoneHash',
  'masked_phone',
  'maskedPhone',
  'phone_masked',
  'name_present',
  'transcript_uri',
  'transcriptUri',
]);

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log']);

function isFakeNumber(match) {
  const normalised = match.startsWith('+') ? match : `+91${match}`;
  return FAKE_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** Collects every string-ish literal value in a node, so template literals are covered too. */
function stringValuesOf(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.raw);
  return [];
}

const noRawPhoneLiteral = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow real-looking phone numbers in source. Use the reserved fake ranges in packages/shared/test/fake-phones.ts.',
    },
    schema: [],
    messages: {
      rawPhone:
        'Possible real phone number "{{match}}" in source (invariant 8). Use a reserved fake range from packages/shared/test/fake-phones.ts, or phone_hash if this is a lookup.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /**
     * Same escape hatch as `pnpm lint:pii`, so a deliberate fixture needs one comment and
     * not one comment plus an eslint-disable. Intended for negative test data — a number
     * that must be outside the reserved ranges precisely because the test asserts it is
     * rejected.
     */
    function isAllowed(node) {
      const line = sourceCode.lines[node.loc.start.line - 1];
      return line !== undefined && line.includes('naaradh-pii-allow');
    }

    function check(node) {
      if (isAllowed(node)) return;
      for (const value of stringValuesOf(node)) {
        for (const pattern of PHONE_PATTERNS) {
          // Fresh lastIndex per use: these regexes are global and module-scoped.
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(value)) !== null) {
            if (isFakeNumber(match[0])) continue;
            context.report({ node, messageId: 'rawPhone', data: { match: match[0] } });
          }
        }
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};

const noPiiInLogs = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow PII-bearing keys in logger call arguments. Log phone_hash, never a dialable number.',
    },
    schema: [],
    messages: {
      piiKey:
        'Logging "{{key}}" risks writing PII to Cloud Logging (invariant 8). Log phone_hash / a masked value instead, and add the field to the redact list in packages/shared/src/logger.ts if it can ever carry PII.',
    },
  },
  create(context) {
    /** logger.info(...), log.warn(...), req.log.error(...), this.logger.debug(...) */
    function isLoggerCall(callee) {
      if (callee.type !== 'MemberExpression') return false;
      if (callee.property.type !== 'Identifier') return false;
      if (!LOG_METHODS.has(callee.property.name)) return false;

      const object = callee.object;
      if (object.type === 'Identifier') {
        return /^(log|logger|console)$/i.test(object.name);
      }
      if (object.type === 'MemberExpression' && object.property.type === 'Identifier') {
        return /^(log|logger)$/i.test(object.property.name);
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isLoggerCall(node.callee)) return;

        for (const arg of node.arguments) {
          if (arg.type !== 'ObjectExpression') continue;
          for (const property of arg.properties) {
            if (property.type !== 'Property') continue;
            const key = property.key;
            const name =
              key.type === 'Identifier'
                ? key.name
                : key.type === 'Literal' && typeof key.value === 'string'
                  ? key.value
                  : undefined;
            if (name === undefined) continue;
            if (PII_SAFE_KEYS.has(name)) continue;
            if (!PII_KEYS.has(name)) continue;
            context.report({ node: property, messageId: 'piiKey', data: { key: name } });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'eslint-plugin-naaradh', version: '0.1.0' },
  rules: {
    'no-raw-phone-literal': noRawPhoneLiteral,
    'no-pii-in-logs': noPiiInLogs,
  },
};
