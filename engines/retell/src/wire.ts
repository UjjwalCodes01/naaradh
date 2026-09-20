/**
 * Retell's wire shapes — only the fields the adapter reads. [VERIFY] every field name against a
 * recorded payload before launch; unknown fields are ignored, missing optional ones are null.
 */

export type RetellCallStatus = 'registered' | 'not_connected' | 'ongoing' | 'ended' | 'error';

export interface RetellWord {
  readonly word: string;
  /** Seconds from the start of the call. */
  readonly start: number;
  readonly end: number;
}

export interface RetellUtterance {
  /** 'agent' | 'user' (Retell may add others; anything not 'agent' is the customer). */
  readonly role: string;
  readonly content: string;
  readonly words?: readonly RetellWord[] | null;
}

export interface RetellCall {
  readonly call_id: string;
  readonly agent_id?: string | null;
  readonly call_status?: RetellCallStatus | null;
  readonly direction?: 'inbound' | 'outbound' | null;
  readonly from_number?: string | null;
  readonly to_number?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  /** Epoch milliseconds. */
  readonly start_timestamp?: number | null;
  readonly end_timestamp?: number | null;
  readonly duration_ms?: number | null;
  readonly transcript_object?: readonly RetellUtterance[] | null;
  readonly recording_url?: string | null;
  readonly disconnection_reason?: string | null;
  readonly call_analysis?: {
    readonly in_voicemail?: boolean | null;
    readonly custom_analysis_data?: Readonly<Record<string, unknown>> | null;
  } | null;
  /** [VERIFY] combined_cost is in US cents. */
  readonly call_cost?: {
    readonly combined_cost?: number | null;
    readonly total_duration_seconds?: number | null;
  } | null;
  readonly transfer_destination?: string | null;
}

export interface RetellWebhook {
  /** 'call_started' | 'call_ended' | 'call_analyzed'; anything else is ignored. */
  readonly event: string;
  readonly call: RetellCall;
}

/** The body Retell posts to a custom function (tool) URL. [VERIFY] */
export interface RetellFunctionCall {
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>> | null;
  readonly call: RetellCall;
}
