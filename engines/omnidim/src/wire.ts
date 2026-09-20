/**
 * OmniDimension's wire shapes — only the fields the adapter reads. [VERIFY] every field against
 * a recorded payload (go-live 03). Odoo-style: an absent value is often `false`, not null.
 */

/** `GET /calls/logs/{id}` and the rows of `GET /calls/logs`. */
export interface OmniCallLog {
  readonly id: number;
  readonly to_number?: string | false | null;
  readonly from_number?: string | false | null;
  readonly call_direction?: string | null;
  /** completed | busy | failed | no-answer (+ voicemail variants). */
  readonly call_status?: string | null;
  readonly call_duration_in_seconds?: number | null;
  readonly recording_url?: string | false | null;
  /** `<br/>`-separated turns, `user:` / `LLM:`. */
  readonly call_conversation?: string | false | null;
  readonly extracted_variables?: Readonly<Record<string, unknown>> | false | null;
  readonly is_voicemail?: boolean | null;
  readonly amd_detected?: boolean | null;
  readonly hangup_source?: string | false | null;
  readonly hangup_reason?: string | false | null;
  /** In the account's billing currency. [VERIFY] USD dollars. */
  readonly call_cost?: number | null;
  readonly aggregated_estimated_cost?: number | null;
  readonly call_request_id?: { readonly id?: number | false | null } | number | false | null;
  /** `MM/DD/YYYY HH:MM:SS`, zone unstated. */
  readonly time_of_call?: string | null;
}

/** The post-call webhook body ("Standard JSON"). */
export interface OmniWebhook {
  readonly call_id?: number | null;
  readonly call_request_id?: number | false | null;
  readonly call_direction?: string | null;
  readonly call_status?: string | null;
  readonly call_duration?: number | null;
  readonly start_time?: string | null;
  readonly end_time?: string | null;
  readonly hangup_source?: string | false | null;
  readonly recording_url?: string | false | null;
  readonly is_voicemail?: boolean | null;
  readonly call_report?: {
    readonly extracted_variables?: Readonly<Record<string, unknown>> | null;
    readonly full_conversation?: string | null;
  } | null;
  /** What we sent as `metadata` on dispatch, echoed back. */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}
