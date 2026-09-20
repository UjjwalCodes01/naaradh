import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  encryptPhone,
  generateApiKey,
  hashPhone,
  loadEnv,
  maskPhone,
  phoneEncryptEnv,
  phoneHashEnv,
  serviceDatabaseEnv,
  staffEncryptEnv,
} from '@naaradh/shared';
import { FAKE_IN, assertFakePhone } from '@naaradh/shared/test/fake-phones';
import { createServiceDb } from './service.js';
import * as s from './schema/index.js';

/**
 * `pnpm db:seed` — two fake merchants and enough surrounding data to exercise every gate
 * step locally with the simulator engine. Idempotent: fixed ids, upserts.
 *
 * Refuses to run against anything that is not localhost unless SEED_ALLOW_REMOTE=1 — a seed
 * against staging would create tenants that look real.
 *
 * Every phone number here is from shared/test/fake-phones.ts and passes through
 * assertFakePhone() before being hashed or encrypted. `purpose_allowed` on the seeded pool
 * numbers is set explicitly BECAUSE these are simulator numbers; it is not a default and
 * must not be copied into provisioning code (Q-01).
 */

const env = loadEnv(
  z.object({
    ...serviceDatabaseEnv,
    ...phoneHashEnv,
    ...phoneEncryptEnv,
    ...staffEncryptEnv,
    SEED_ALLOW_REMOTE: z.string().optional(),
  }),
);

const host = new URL(env.DATABASE_SERVICE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && env.SEED_ALLOW_REMOTE !== '1') {
  console.error(
    `refusing to seed a non-local database (${host}); set SEED_ALLOW_REMOTE=1 if you really mean it`,
  );
  process.exit(2);
}

/** Deterministic ids: valid prefixed ULIDs (Crockford base32) that are obviously seed data. */
const fixed = (prefix: string, label: string) => {
  const body = `01SEED${label.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '')}`
    .padEnd(26, '0')
    .slice(0, 26);
  return `${prefix}_${body}`;
};

const TENANT_A = fixed('ten', 'CLIENTA');
const TENANT_B = fixed('ten', 'CLIENTB');
const KID = env.PHONE_ENC_KID;

const phone = (e164: string) => {
  assertFakePhone(e164);
  const enc = encryptPhone(e164, env.PHONE_ENC_PUBLIC_KEY, KID);
  return {
    phoneHash: hashPhone(e164, env.PHONE_HASH_KEY),
    phoneEnc: enc.ciphertext,
    phoneEncKid: KID,
    phoneMasked: maskPhone(e164),
  };
};

/** Staff numbers (transfer targets, fallback lines) use the STAFF key pair — invariant 19. */
const staffPhone = (e164: string) => {
  assertFakePhone(e164);
  const enc = encryptPhone(e164, env.STAFF_ENC_PUBLIC_KEY, env.STAFF_ENC_KID);
  return {
    phoneHash: hashPhone(e164, env.PHONE_HASH_KEY),
    phoneEnc: enc.ciphertext,
    phoneEncKid: env.STAFF_ENC_KID,
    phoneMasked: maskPhone(e164),
  };
};

/** Mirrors pipeline hashPincode (the pipeline depends on this package, not the reverse). */
const pincodeHash = (pin: string) =>
  createHmac('sha256', env.PHONE_HASH_KEY)
    .update(`pincode:${pin.replace(/\s+/g, '').toUpperCase()}`)
    .digest('hex');

const customerHashForOrders = () => hashPhone(FAKE_IN.customer, env.PHONE_HASH_KEY);

/** Client A's support line — reserved test range, answered by the simulator. */
const SUPPORT_LINE_A = '+916000000200';

const { db, close } = createServiceDb({
  url: env.DATABASE_SERVICE_URL,
  applicationName: 'naaradh-seed',
});

try {
  await db.transaction(async (tx) => {
    // ---- tenants ---------------------------------------------------------------------
    await tx
      .insert(s.tenants)
      .values([
        {
          id: TENANT_A,
          name: 'Client A (Shopify, COD)',
          legalName: 'Client A Retail Pvt Ltd',
          country: 'IN',
          dataRegion: 'in',
          status: 'active',
          dltPeId: 'PE-SEED-A',
          dltLinkedAt: new Date(),
          spendCapDailyPaise: 200_000_00,
          spendCapMonthlyPaise: 4_000_000_00,
          maxConcurrency: 3,
          billingProvider: 'shopify',
          billingStatus: 'active',
          planCode: 'growth',
          inboundPlanCode: 'inbound_growth',
        },
        {
          id: TENANT_B,
          name: 'Client B (API, lead callback)',
          legalName: 'Client B Services LLP',
          country: 'IN',
          dataRegion: 'in',
          status: 'active',
          spendCapDailyPaise: 50_000_00,
          maxConcurrency: 2,
          billingProvider: 'razorpay',
          billingStatus: 'active',
          planCode: 'starter',
        },
      ])
      .onConflictDoUpdate({
        target: s.tenants.id,
        set: { name: sql`excluded.name`, status: sql`excluded.status` },
      });

    // ---- users ------------------------------------------------------------------------
    await tx
      .insert(s.users)
      .values([
        {
          id: fixed('usr', 'A OWNER'),
          tenantId: TENANT_A,
          email: 'owner@client-a.example',
          name: 'Asha Owner',
          role: 'owner',
          mfaEnabled: true,
        },
        {
          id: fixed('usr', 'A OPS'),
          tenantId: TENANT_A,
          email: 'ops@client-a.example',
          name: 'Omar Ops',
          role: 'operator',
        },
        {
          id: fixed('usr', 'B OWNER'),
          tenantId: TENANT_B,
          email: 'owner@client-b.example',
          name: 'Bela Owner',
          role: 'owner',
          mfaEnabled: true,
        },
      ])
      .onConflictDoNothing();

    // ---- integrations -----------------------------------------------------------------
    await tx
      .insert(s.integrations)
      .values([
        {
          id: fixed('itg', 'A SHOPIFY'),
          tenantId: TENANT_A,
          kind: 'shopify',
          externalId: 'client-a-dev.myshopify.com',
          apiVersion: '2026-07',
          scopes: [
            'read_orders',
            'write_orders',
            'read_customers',
            'write_customers',
            'read_checkouts',
            'read_fulfillments',
            'read_locales',
          ],
          metadata: { usesShopifyCheckout: true },
        },
        {
          id: fixed('itg', 'B API'),
          tenantId: TENANT_B,
          kind: 'api',
          externalId: 'client-b.example',
        },
      ])
      .onConflictDoNothing();

    // ---- use cases + scripts ---------------------------------------------------------
    const USECASE_A_COD = fixed('usc', 'A COD');
    const USECASE_A_CART = fixed('usc', 'A CART');
    const USECASE_B_LEAD = fixed('usc', 'B LEAD');
    await tx
      .insert(s.useCases)
      .values([
        {
          id: USECASE_A_COD,
          tenantId: TENANT_A,
          kind: 'cod_confirm',
          purpose: 'transactional',
          enabled: true,
          config: { defaultLocale: 'hi-IN', minOrderValuePaise: 0, pilotPercent: 100 },
        },
        {
          id: USECASE_A_CART,
          tenantId: TENANT_A,
          kind: 'abandoned_cart',
          purpose: 'promotional',
          enabled: false,
          config: { defaultLocale: 'hi-IN' },
        },
        {
          id: USECASE_B_LEAD,
          tenantId: TENANT_B,
          kind: 'lead_callback',
          purpose: 'service',
          enabled: true,
          config: { defaultLocale: 'en-IN' },
        },
      ])
      .onConflictDoNothing();

    // Draft scripts: the disclosure validator (call-scripts) is what approves them.
    await tx
      .insert(s.scripts)
      .values([
        {
          id: fixed('scr', 'A COD HI 1'),
          tenantId: TENANT_A,
          useCaseId: USECASE_A_COD,
          version: 1,
          locale: 'hi-IN',
          status: 'draft',
          body: {
            use_case: 'cod_confirm',
            locale: 'hi-IN',
            opening:
              'Namaste {{customer_name}}, main {{brand}} ki taraf se automated AI assistant bol rahi hoon, yeh call record ho rahi hai.',
            purpose_line:
              'Aapne {{order_ref}} ka order kiya hai, ₹{{amount}} cash on delivery. Kya hum ise ship kar dein?',
            branches: [],
            closing: 'Dhanyavaad.',
            max_duration_sec: 120,
            forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password'],
          },
        },
        {
          id: fixed('scr', 'B LEAD EN 1'),
          tenantId: TENANT_B,
          useCaseId: USECASE_B_LEAD,
          version: 1,
          locale: 'en-IN',
          status: 'draft',
          body: {
            use_case: 'lead_callback',
            locale: 'en-IN',
            opening:
              'Hi {{customer_name}}, this is an automated AI assistant calling from {{brand}}; this call is being recorded.',
            purpose_line: 'You asked us to call back about {{topic}}. Is now a good time?',
            branches: [],
            closing: 'Thank you.',
            max_duration_sec: 180,
            forbidden_topics: ['otp', 'card', 'upi_pin', 'aadhaar', 'password'],
          },
        },
      ])
      .onConflictDoNothing();

    // ---- CLI pool (simulator) ----------------------------------------------------------
    await tx
      .insert(s.numbers)
      .values([
        {
          id: fixed('num', 'POOL IN 1'),
          tenantId: null,
          e164: FAKE_IN.merchant,
          region: 'IN',
          series: '10digit',
          provider: 'simulator',
          engine: 'simulator',
          purposeAllowed: ['transactional', 'service'],
          status: 'active',
          answerRate7d: '0.4100',
          provisioningNote: 'SEED — simulator number; purpose_allowed set for tests only (Q-01)',
        },
        {
          id: fixed('num', 'POOL IN 2'),
          tenantId: null,
          e164: FAKE_IN.transferTarget,
          region: 'IN',
          series: '10digit',
          provider: 'simulator',
          engine: 'simulator',
          purposeAllowed: [],
          status: 'warming',
          provisioningNote:
            'SEED — no purposes allowed: exercises gate step 11 (cli:none_available)',
        },
      ])
      .onConflictDoNothing();

    // ---- contacts -----------------------------------------------------------------------
    const contact = (
      id: string,
      tenantId: string,
      e164: string,
      extra: Partial<typeof s.contacts.$inferInsert> = {},
    ) => ({
      id,
      tenantId,
      ...phone(e164),
      region: 'IN',
      ...extra,
    });
    await tx
      .insert(s.contacts)
      .values([
        contact(fixed('cnt', 'A CUSTOMER'), TENANT_A, FAKE_IN.customer, {
          name: 'Test Customer',
          phoneType: 'mobile',
          localeHint: 'hi-IN',
        }),
        contact(fixed('cnt', 'A OPTEDOUT'), TENANT_A, FAKE_IN.optedOut, {
          name: 'Opted Out',
          phoneType: 'mobile',
        }),
        contact(fixed('cnt', 'A DND'), TENANT_A, FAKE_IN.dnd, {
          name: 'On DND',
          phoneType: 'mobile',
        }),
        contact(fixed('cnt', 'A LANDLINE'), TENANT_A, FAKE_IN.landline, {
          name: 'Landline',
          phoneType: 'landline',
          phoneTypeCheckedAt: new Date(),
        }),
        contact(fixed('cnt', 'A MINOR'), TENANT_A, FAKE_IN.minorAnswered, {
          name: 'Household',
          phoneType: 'mobile',
        }),
        contact(fixed('cnt', 'B LEAD'), TENANT_B, FAKE_IN.customerAlt, {
          name: 'Lead One',
          phoneType: 'mobile',
          localeHint: 'en-IN',
        }),
      ])
      .onConflictDoNothing();

    // ---- consents (append-only; seed inserts only if absent) ----------------------------
    const customerHash = phone(FAKE_IN.customer).phoneHash;
    await tx
      .insert(s.consents)
      .values({
        id: fixed('con', 'A CUSTOMER PROMO'),
        tenantId: TENANT_A,
        phoneHash: customerHash,
        purpose: 'promotional',
        source: 'checkout',
        recipientRegion: 'IN',
        // Must be a version in CONSENT_WORDINGS (pipeline/src/promotional/
        // consent-wording.ts); db cannot import pipeline, so it is written out here.
        wordingVersion: '2026-09-v1-draft',
        externalRef: 'order-seed-1',
        capturedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        context: { checkbox: 'naaradh_call_consent' },
      })
      .onConflictDoNothing();

    // ---- suppressions -------------------------------------------------------------------
    await tx
      .insert(s.suppressions)
      .values([
        {
          id: fixed('sup', 'A OPTEDOUT'),
          tenantId: TENANT_A,
          phoneHash: phone(FAKE_IN.optedOut).phoneHash,
          purpose: 'all',
          reason: 'opt_out',
          until: new Date(Date.now() + 90 * 86_400_000),
          createdBy: 'seed',
        },
        {
          id: fixed('sup', 'A MINOR'),
          tenantId: TENANT_A,
          phoneHash: phone(FAKE_IN.minorAnswered).phoneHash,
          purpose: 'all',
          reason: 'minor',
          until: new Date(Date.now() + 90 * 86_400_000),
          createdBy: 'seed',
        },
      ])
      .onConflictDoNothing();

    // ---- caches: DND registered, landline typed -----------------------------------------
    await tx
      .insert(s.dndScrubCache)
      .values({
        phoneHash: phone(FAKE_IN.dnd).phoneHash,
        region: 'IN',
        result: 'registered',
        provider: 'seed',
        checkedAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
      })
      .onConflictDoNothing();
    await tx
      .insert(s.numberTypeCache)
      .values({
        phoneHash: phone(FAKE_IN.landline).phoneHash,
        phoneType: 'landline',
        provider: 'seed',
        checkedAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
      })
      .onConflictDoNothing();

    // ---- transfer target (verified, STAFF key) ----------------------------------------------
    const manager = staffPhone(FAKE_IN.transferTarget);
    await tx
      .insert(s.transferTargets)
      .values({
        id: fixed('trf', 'A MANAGER'),
        tenantId: TENANT_A,
        label: 'Store manager',
        ...manager,
        region: 'IN',
        verifiedAt: new Date(),
        hours: { zone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '19:00' },
      })
      .onConflictDoUpdate({
        target: s.transferTargets.id,
        // Earlier seeds encrypted this with the customer key; re-seeding repairs it.
        set: { phoneEnc: manager.phoneEnc, phoneEncKid: manager.phoneEncKid },
      });

    // ---- support line (ADR-0006): profile → number, knowledge, order cache ------------------
    const PROFILE_A = fixed('ipr', 'A SUPPORT');
    const fallback = staffPhone(FAKE_IN.merchant);
    await tx
      .insert(s.inboundProfiles)
      .values({
        id: PROFILE_A,
        tenantId: TENANT_A,
        name: 'Client A support line',
        status: 'active',
        locale: 'hi-IN',
        // Same text as DEFAULT_INBOUND_GREETINGS['hi-IN'] in call-scripts — disclosure first.
        greeting:
          'Namaste, {{brand}} mein aapka swagat hai. Main ek automated AI assistant hoon aur yeh call record ho rahi hai. Main aapki kya madad kar sakti hoon?',
        persona:
          'Warm, patient and brief. Uses simple Hindi, switches to English if the caller does.',
        businessHours: {
          zone: 'Asia/Kolkata',
          days: [1, 2, 3, 4, 5, 6],
          open: '09:00',
          close: '21:00',
        },
        toolsEnabled: [
          'lookup_orders',
          'verify_caller',
          'search_knowledge',
          'confirm_order',
          'request_cancellation',
          'request_address_change',
          'create_ticket',
          'transfer_to_human',
          'register_opt_out',
        ],
        pinnedFacts: [
          'Delivery takes 3 to 5 working days.',
          'Cash on delivery is available on all orders.',
        ],
        closedMessage:
          '{{brand}} ko call karne ke liye dhanyavaad. Abhi hum aapki call nahi le pa rahe hain. Kripya {{hours}} ke beech dobara call karein.',
        fallbackForwardEnc: fallback.phoneEnc,
        fallbackForwardKid: fallback.phoneEncKid,
        fallbackForwardMasked: fallback.phoneMasked,
        transferTargetId: fixed('trf', 'A MANAGER'),
        maxConcurrent: 2,
        // Invariant 14 (as amended by ADR-0006): ON in the seed so the two-step path is testable locally.
        agentCancelEnabled: true,
      })
      .onConflictDoNothing();
    await tx
      .insert(s.numbers)
      .values({
        id: fixed('num', 'A SUPPORT'),
        tenantId: TENANT_A,
        e164: SUPPORT_LINE_A,
        region: 'IN',
        series: '10digit',
        provider: 'simulator',
        engine: 'simulator',
        purposeAllowed: ['service'],
        inboundEnabled: true,
        inboundProfileId: PROFILE_A,
        status: 'active',
        provisioningNote: 'SEED — simulator support line (ADR-0006)',
      })
      .onConflictDoNothing();
    await tx
      .insert(s.knowledgeArticles)
      .values([
        {
          id: fixed('kba', 'A RETURNS'),
          tenantId: TENANT_A,
          title: 'Return policy',
          body: 'Unused items can be returned within 7 days of delivery. Refunds reach the original payment method in 5 to 7 working days after we receive the item. COD refunds go to a bank account the customer shares with our team.',
          status: 'published',
        },
        {
          id: fixed('kba', 'A DELIVERY'),
          tenantId: TENANT_A,
          title: 'Delivery times',
          body: 'Orders ship within 1 working day. Metro cities: 2 to 3 days. Other pincodes: 4 to 6 days. We deliver to all serviceable pincodes in India.',
          status: 'published',
        },
        {
          id: fixed('kba', 'A WAPSI'),
          tenantId: TENANT_A,
          title: 'वापसी नीति',
          locale: 'hi-IN',
          body: 'बिना इस्तेमाल किया सामान डिलीवरी के 7 दिन के अंदर वापस किया जा सकता है।',
          status: 'published',
        },
        {
          id: fixed('kba', 'A DRAFT'),
          tenantId: TENANT_A,
          title: 'Festive sale (draft)',
          body: 'Not published yet — the agent must never read this.',
          status: 'draft',
        },
      ])
      .onConflictDoNothing();
    const placed = new Date(Date.now() - 2 * 86_400_000);
    await tx
      .insert(s.orders)
      .values([
        {
          id: fixed('ord', 'A 1001'),
          tenantId: TENANT_A,
          source: 'shopify',
          externalId: '9001001',
          name: '#1001',
          nameKey: '1001',
          phoneHash: customerHashForOrders(),
          pincodeHash: pincodeHash('110001'),
          paymentKind: 'cod',
          financialStatus: 'pending',
          fulfillmentStatus: null,
          totalMinor: 49900,
          currency: 'INR',
          itemSummary: '1 × Cotton kurta',
          itemCount: 1,
          placedAt: placed,
          sourceUpdatedAt: placed,
        },
        {
          id: fixed('ord', 'A 1002'),
          tenantId: TENANT_A,
          source: 'shopify',
          externalId: '9001002',
          name: '#1002',
          nameKey: '1002',
          phoneHash: customerHashForOrders(),
          pincodeHash: pincodeHash('110001'),
          paymentKind: 'prepaid',
          financialStatus: 'paid',
          fulfillmentStatus: 'in_transit',
          totalMinor: 129900,
          currency: 'INR',
          itemSummary: '2 items',
          itemCount: 2,
          tracking: {
            company: 'Delhivery',
            number: 'SEED123',
            url: null,
            status: 'in_transit',
            estimatedDelivery: null,
          },
          placedAt: placed,
          sourceUpdatedAt: placed,
        },
      ])
      .onConflictDoNothing();

    // ---- an abandoned checkout to sweep (ADR-0010) ----------------------------------------
    // Idle for an hour with a live consent, so `pnpm dev` (reconcile) turns it into one
    // abandoned-cart intent — which the gate then refuses `dnd:unknown` until a scrub provider
    // exists (Q-02). That refusal is the point: it is what a merchant sees before go-live.
    const abandoned = new Date(Date.now() - 60 * 60_000);
    await tx
      .insert(s.checkouts)
      .values({
        id: fixed('chk', 'A CART 1'),
        tenantId: TENANT_A,
        source: 'shopify',
        externalId: 'seed-checkout-1',
        phoneHash: customerHash,
        contactId: fixed('cnt', 'A CUSTOMER'),
        recipientRegion: 'IN',
        valueMinor: 129900,
        currency: 'INR',
        itemSummary: '2 items',
        itemCount: 2,
        consentWording: '2026-09-v1-draft',
        status: 'open',
        sourceCreatedAt: abandoned,
        sourceUpdatedAt: abandoned,
      })
      .onConflictDoNothing();

    // ---- flags + kill switches -----------------------------------------------------------
    await tx
      .insert(s.flags)
      .values([
        {
          tenantId: null,
          key: 'dnd.scrub_transactional',
          value: true,
          reason: 'Q-02 conservative default',
          updatedBy: 'seed',
        },
        {
          tenantId: null,
          key: 'shopify.sync_optout',
          value: false,
          reason: 'Q-07 conservative default',
          updatedBy: 'seed',
        },
      ])
      .onConflictDoNothing();
    await tx
      .insert(s.killSwitches)
      .values([
        { scope: 'global', key: '*', active: false, setBy: 'seed' },
        { scope: 'engine', key: 'simulator', active: false, setBy: 'seed' },
      ])
      .onConflictDoNothing();
  });

  // ---- API key for Client B: created outside the seed transaction so the plaintext is
  // printed exactly once and only when newly created.
  const existing = await db
    .select({ id: s.apiKeys.id })
    .from(s.apiKeys)
    .where(sql`${s.apiKeys.id} = ${fixed('key', 'B TEST')}`);
  if (existing.length === 0) {
    const k = generateApiKey('test');
    await db.insert(s.apiKeys).values({
      id: fixed('key', 'B TEST'),
      tenantId: TENANT_B,
      name: 'seed test key',
      kind: 'secret',
      keyHash: k.keyHash,
      prefix: k.prefix,
      scopes: ['intents:create', 'intents:read', 'consents:write', 'suppressions:write'],
    });
    console.log(`Client B test API key (shown once): ${k.key}`);
  }

  console.log(`seeded tenants ${TENANT_A} (Client A) and ${TENANT_B} (Client B)`);
  console.log(
    `Client A support line (simulator): ${maskPhone(SUPPORT_LINE_A)} → profile ${fixed('ipr', 'A SUPPORT')}`,
  );
} finally {
  await close();
}
