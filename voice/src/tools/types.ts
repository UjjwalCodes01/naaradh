import type { Tx } from '@naaradh/db';
import type { CallerState, Identity } from '@naaradh/compliance';
import type { ToolResult } from '@naaradh/engines-core';
import { effectiveIdentity, type AgentActionStatus } from '@naaradh/pipeline';
import type { ToolName } from '@naaradh/call-scripts';
import type { VoiceDeps } from '../context.js';
import type { ProfileRow } from '../profiles.js';

/** The attempt as the tools see it — identity is read from HERE, never from the model. */
export interface ToolAttempt {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly status: string;
  readonly contactId: string | null;
  readonly phoneHash: string | null;
  readonly intentId: string | null;
  readonly callerVerification: Identity;
  readonly verifiedOrderIds: readonly string[];
  readonly verifyFailures: number;
  readonly transferTargetId: string | null;
  readonly inboundProfileId: string | null;
}

export interface ToolCtx {
  readonly tx: Tx;
  readonly deps: VoiceDeps;
  readonly tenantId: string;
  readonly vendor: string;
  readonly now: Date;
  /** Id of the agent_actions row this call will write (dependent rows reference it). */
  readonly actionId: string;
  readonly attempt: ToolAttempt;
  /** Inbound: the profile that answered. Outbound: the tenant's active support profile, if any. */
  readonly profile: ProfileRow | null;
  /** Tools this call was given — a result never suggests a tool the agent does not have. */
  readonly tools: readonly ToolName[];
}

export interface HandlerOutcome {
  readonly status: AgentActionStatus;
  readonly result: ToolResult;
  readonly orderId?: string | null;
  readonly ticketId?: string | null;
  readonly parentActionId?: string | null;
  readonly confirmTokenHash?: string | null;
  readonly tokenExpiresAt?: Date | null;
  /** Stored in agent_actions instead of result.data when the latter carries a secret (token, staff number). */
  readonly stored?: Readonly<Record<string, unknown>>;
  /** Runs after the agent_actions row exists (rows that reference it by FK). */
  readonly after?: () => Promise<void>;
}

export function callerState(a: ToolAttempt): CallerState {
  return {
    identity: effectiveIdentity({
      attemptId: a.id,
      direction: a.direction,
      callerHash: a.phoneHash,
      identity: a.callerVerification,
      verifiedOrderIds: a.verifiedOrderIds,
      verifyFailures: a.verifyFailures,
    }),
    callerHash: a.phoneHash,
    verifiedOrderIds: a.verifiedOrderIds,
  };
}

export function ok(data: Record<string, unknown>, say: string | null = null): ToolResult {
  return { ok: true, data, say, action: null };
}

export function fail(data: Record<string, unknown>, say: string | null = null): ToolResult {
  return { ok: false, data, say, action: null };
}
