/**
 * Bolna's wire shapes — only the fields the adapter reads. One object, the "execution", is the
 * call record: returned by `GET /executions/{id}`, and POSTed to the agent's webhook on every
 * status change. [VERIFY] every field against a recorded payload (go-live 03).
 */

export interface BolnaTelephony {
  readonly duration?: number | string | null;
  readonly to_number?: string | null;
  readonly from_number?: string | null;
  readonly recording_url?: string | null;
  readonly call_type?: string | null;
  readonly provider?: string | null;
  readonly hangup_by?: string | null;
  readonly hangup_reason?: string | null;
  readonly hangup_provider_code?: number | null;
}

export interface BolnaExecution {
  readonly id: string;
  readonly agent_id?: string | null;
  /**
   * queued → initiated → ringing → in-progress → call-disconnected → completed, or one of
   * no-answer, busy, failed, canceled, stopped, error, balance-low. Only `completed` and those
   * are final; `call-disconnected` still has empty duration, cost, transcript and extraction.
   */
  readonly status: string;
  readonly error_message?: string | null;
  /** Conversation seconds. 0 = nobody talked, whatever `status` says. The figure Bolna bills. */
  readonly conversation_duration?: number | null;
  readonly answered_by_voice_mail?: boolean | null;
  readonly created_at?: string | null;
  readonly initiated_at?: string | null;
  readonly updated_at?: string | null;
  /** Newline-delimited `assistant: …` / `user: …`. */
  readonly transcript?: string | null;
  readonly extracted_data?: Readonly<Record<string, unknown>> | null;
  readonly telephony_data?: BolnaTelephony | null;
  /** In cents. [VERIFY] the currency against an invoice (assumed USD). */
  readonly total_cost?: number | null;
  readonly cost_breakdown?: { readonly total_cost_to_deduct?: number | null } | null;
  /** What we sent as `user_data` comes back under `recipient_data`. */
  readonly context_details?: {
    readonly recipient_data?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly transfer_call_data?: { readonly status?: string | null } | null;
}
