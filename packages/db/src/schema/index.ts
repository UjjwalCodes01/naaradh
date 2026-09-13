/**
 * Drizzle schema — mirrors SPEC §6.5 (v1.1) with the additions recorded in ADR-0004 and the
 * inbound/transfer discussion (direction, transfer_targets).
 *
 * Tables, columns, indexes and CHECKs live here and are generated into SQL by drizzle-kit.
 * Everything drizzle-kit cannot express — RLS policies, FORCE RLS, grants, the
 * app_tenant_id() function, append-only and immutability triggers, security-invoker views —
 * is hand-written in packages/db/migrations/0001_rls_grants_triggers.sql, where a reviewer
 * can read it as SQL.
 */
export * from './enums.js';
export * from './tenants.js';
export * from './contacts.js';
export * from './calls.js';
export * from './system.js';
export * from './inbound.js';
export * from './auth.js';
