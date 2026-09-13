import { GATE_REASONS, type GateReason, type GateReasonInfo } from '@naaradh/compliance';

/**
 * The dashboard explains calls in business terms (P2-WEB-1, AGENTS §5.2): every machine code
 * a merchant can see has a label here and, where the merchant may need to act, a hint. Gate
 * reasons come from packages/compliance (the only place they are defined); everything else —
 * outcomes, statuses, write-backs — is defined once here for both dashboards.
 */

export interface Explained {
  readonly label: string;
  readonly explanation: string;
  readonly tone: 'good' | 'neutral' | 'warning' | 'bad';
}

const OUTCOMES: Record<string, Explained> = {
  confirmed: { label: 'Confirmed', explanation: 'The customer confirmed the order.', tone: 'good' },
  confirmed_with_changes: {
    label: 'Confirmed with changes',
    explanation: 'Confirmed, with a change the customer asked for (see details).',
    tone: 'good',
  },
  cancelled: {
    label: 'Cancelled by customer',
    explanation: 'The customer said they no longer want the order.',
    tone: 'warning',
  },
  rescheduled: {
    label: 'Rescheduled',
    explanation: 'The customer asked for a different delivery or appointment time.',
    tone: 'good',
  },
  booked: { label: 'Booked', explanation: 'An appointment was booked.', tone: 'good' },
  no_answer: { label: 'No answer', explanation: 'Nobody picked up.', tone: 'neutral' },
  busy: { label: 'Busy', explanation: 'The line was busy.', tone: 'neutral' },
  voicemail: {
    label: 'Voicemail',
    explanation: 'A voicemail or answering machine picked up.',
    tone: 'neutral',
  },
  no_response: {
    label: 'No response',
    explanation: 'Someone answered but did not respond.',
    tone: 'neutral',
  },
  inconclusive: {
    label: 'Inconclusive',
    explanation: 'The conversation did not produce a clear answer. Not billed.',
    tone: 'neutral',
  },
  failed: {
    label: 'Call failed',
    explanation: 'The call could not be completed for a technical reason. Not billed.',
    tone: 'bad',
  },
  wrong_number: {
    label: 'Wrong number',
    explanation: 'The person who answered is not the customer. The number is suppressed.',
    tone: 'warning',
  },
  minor_answered: {
    label: 'Minor answered',
    explanation: 'A child answered; the call was ended (E-11).',
    tone: 'warning',
  },
  opt_out: {
    label: 'Opted out',
    explanation: 'The customer asked not to be called. Naaradh will not call them again.',
    tone: 'warning',
  },
  recording_refused: {
    label: 'Refused recording',
    explanation: 'The customer did not agree to the call being recorded; the call was ended.',
    tone: 'neutral',
  },
  transferred: {
    label: 'Transferred',
    explanation: 'The call was handed to your team.',
    tone: 'good',
  },
  transfer_failed: {
    label: 'Transfer failed',
    explanation: 'Your team did not pick up the transfer; a callback ticket was created.',
    tone: 'warning',
  },
  callback_requested: {
    label: 'Callback requested',
    explanation: 'The customer asked to be called back later.',
    tone: 'neutral',
  },
  needs_merchant_action: {
    label: 'Needs your action',
    explanation: 'The customer asked for something only your team can do. See the ticket.',
    tone: 'warning',
  },
  convert_to_prepaid_requested: {
    label: 'Wants to pay online',
    explanation: 'The customer asked to switch to prepaid.',
    tone: 'neutral',
  },
  outcome_superseded: {
    label: 'Order changed during the call',
    explanation:
      'The order was cancelled or changed while the call was ringing. Not billed (E-40).',
    tone: 'neutral',
  },
  resolved: {
    label: 'Resolved',
    explanation: 'The agent answered the caller without needing your team.',
    tone: 'good',
  },
  ticket_created: {
    label: 'Ticket created',
    explanation: 'The caller needs something from your team. See Tickets.',
    tone: 'warning',
  },
  abandoned: { label: 'Caller hung up', explanation: 'The caller left early.', tone: 'neutral' },
  spam: { label: 'Spam', explanation: 'Not a genuine customer call.', tone: 'neutral' },
};

export function explainOutcome(outcome: string): Explained {
  return (
    OUTCOMES[outcome] ?? { label: outcome.replaceAll('_', ' '), explanation: '', tone: 'neutral' }
  );
}

const INTENT_STATUS: Record<string, Explained> = {
  CREATED: { label: 'Received', explanation: 'Naaradh received the order.', tone: 'neutral' },
  SCHEDULED: {
    label: 'Scheduled',
    explanation: 'The call is queued and will be placed shortly.',
    tone: 'neutral',
  },
  GATED: {
    label: 'Not called',
    explanation: 'A compliance check stopped this call. See the reason.',
    tone: 'warning',
  },
  DISPATCHING: { label: 'Dialling', explanation: 'The call is being placed.', tone: 'neutral' },
  IN_PROGRESS: { label: 'On a call', explanation: 'The call is in progress.', tone: 'neutral' },
  RETRY_SCHEDULED: {
    label: 'Retrying',
    explanation: 'No answer yet; another attempt is scheduled inside the calling window.',
    tone: 'neutral',
  },
  COMPLETED: {
    label: 'Completed',
    explanation: 'The call finished with an outcome.',
    tone: 'good',
  },
  EXHAUSTED: {
    label: 'No answer after retries',
    explanation: 'Every allowed attempt was made without reaching the customer.',
    tone: 'neutral',
  },
  EXPIRED: {
    label: 'Expired',
    explanation: 'The time allowed for this call passed before it could be placed.',
    tone: 'neutral',
  },
  CANCELLED: {
    label: 'Cancelled',
    explanation: 'The call was cancelled (order changed, app uninstalled, or cancelled by you).',
    tone: 'neutral',
  },
};

export function explainIntentStatus(status: string): Explained {
  return INTENT_STATUS[status] ?? { label: status, explanation: '', tone: 'neutral' };
}

const WRITEBACK: Record<string, Explained> = {
  pending: {
    label: 'Updating order',
    explanation: 'Writing the result to your store.',
    tone: 'neutral',
  },
  done: {
    label: 'Order updated',
    explanation: 'Tags, note and fields were written.',
    tone: 'good',
  },
  failed: {
    label: 'Order not updated',
    explanation: 'Naaradh could not write to your store. Reopen the app to reconnect.',
    tone: 'bad',
  },
  skipped: { label: 'Nothing to write', explanation: '', tone: 'neutral' },
  needs_review: {
    label: 'Needs review',
    explanation:
      'A change (such as a new address) needs a person to apply it. Naaradh never writes addresses.',
    tone: 'warning',
  },
};

export function explainWriteback(status: string): Explained {
  return WRITEBACK[status] ?? { label: status, explanation: '', tone: 'neutral' };
}

const IDENTITY: Record<string, Explained> = {
  none: {
    label: 'Not verified',
    explanation: 'The caller only heard general information and could leave a ticket.',
    tone: 'neutral',
  },
  caller_id: {
    label: 'Caller ID',
    explanation:
      "Called from the number on the order, so the agent could discuss that customer's orders.",
    tone: 'good',
  },
  knowledge: {
    label: 'Order number + pincode',
    explanation: 'The caller proved they know the order details.',
    tone: 'good',
  },
};

export function explainIdentity(level: string): Explained {
  return IDENTITY[level] ?? { label: level, explanation: '', tone: 'neutral' };
}

/** Gate refusals: title, explanation and "what to do" from packages/compliance. */
export function explainGate(reason: string | null): GateReasonInfo | null {
  if (reason === null) return null;
  if (Object.hasOwn(GATE_REASONS, reason)) return GATE_REASONS[reason as GateReason];
  return {
    title: 'Not called',
    explanation: `Stopped by a check Naaradh does not describe yet (${reason}).`,
    hint: 'Contact support with this order reference.',
    temporary: false,
  };
}

const AGENT_ACTION: Record<string, string> = {
  ok: 'Done',
  refused: 'Refused',
  needs_verification: 'Asked the caller to verify',
  awaiting_confirmation: 'Waiting for the caller to confirm',
  approved: 'Approved',
  ticketed: 'Turned into a ticket',
  failed: 'Failed',
};

export function explainAgentAction(status: string): string {
  return AGENT_ACTION[status] ?? status;
}
