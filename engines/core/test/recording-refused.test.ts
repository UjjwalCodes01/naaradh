import { describe, expect, it } from 'vitest';
import { recordingRefused, withoutRefusedMedia, type EngineEvent } from '../src/index.js';

const ended = (over: Partial<Extract<EngineEvent, { type: 'call.ended' }>> = {}) =>
  ({
    type: 'call.ended',
    eventId: 'e1',
    vendor: 'simulator',
    vendorCallId: 'c1',
    attemptId: null,
    occurredAt: new Date('2026-09-20T10:00:00Z'),
    reason: 'agent_hangup',
    answeredBy: 'human',
    durationSec: 20,
    billableSec: 20,
    humanSpeechSec: 5,
    recordingUrl: 'https://vendor.test/rec.wav',
    transcript: [{ role: 'agent', text: 'hello', startMs: 0 }],
    extracted: null,
    detectedLocale: null,
    vendorCost: null,
    ...over,
  }) as Extract<EngineEvent, { type: 'call.ended' }>;

describe('a refused recording keeps neither audio nor words (P6-CMP-1)', () => {
  it('is recognised from the end reason or from the extraction alone', () => {
    expect(recordingRefused(ended({ reason: 'recording_refused' }))).toBe(true);
    expect(recordingRefused(ended({ extracted: { outcome: 'recording_refused' } }))).toBe(true);
    expect(recordingRefused(ended())).toBe(false);
  });

  it('strips the recording link and transcript before anything is stored', () => {
    const stripped = withoutRefusedMedia(ended({ extracted: { outcome: 'recording_refused' } }));
    expect(stripped).toMatchObject({ recordingUrl: null, transcript: null });
    const kept = withoutRefusedMedia(ended());
    expect(kept).toMatchObject({ recordingUrl: 'https://vendor.test/rec.wav' });
  });
});
