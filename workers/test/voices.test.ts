import { describe, expect, it } from 'vitest';
import { KNOWN_VENDORS } from '@naaradh/engines-registry';
import {
  VOICE_ENGINES,
  VoiceOverrideInput,
  parseVoiceOverrides,
  voiceFor,
} from '@naaradh/pipeline';

/** P7-ENT-1 custom voices: what an outbound agent speaks with. */

describe('voice engines', () => {
  it('match the engine registry exactly (pipeline keeps its own copy to stay out of web)', () => {
    expect([...VOICE_ENGINES].sort()).toEqual([...KNOWN_VENDORS].sort());
  });
});

describe('voiceFor', () => {
  const stored = { retell: { 'en-US': '11labs-BrandVoice', 'en-GB': 'custom:uk-1' } };
  it('uses the tenant voice for that engine and locale', () => {
    expect(voiceFor(stored, 'retell', 'en-US')).toBe('11labs-BrandVoice');
  });
  it('falls back to the engine default for another locale or engine', () => {
    expect(voiceFor(stored, 'retell', 'de-DE')).toBe('default');
    expect(voiceFor(stored, 'bolna', 'en-US')).toBe('default');
  });
  it('falls back to the default when nothing is stored', () => {
    expect(voiceFor({}, 'retell', 'en-US')).toBe('default');
    expect(voiceFor(null, 'retell', 'en-US')).toBe('default');
  });
});

describe('parseVoiceOverrides ignores anything it could not safely send to a vendor', () => {
  it('drops non-strings, bad shapes and ids with quotes or spaces', () => {
    expect(
      parseVoiceOverrides({
        retell: { 'en-US': 'ok-voice', 'en-GB': 42, 'de-DE': 'has space', 'fr-FR': 'x"}' },
        bolna: 'not-an-object',
        omnidim: ['nope'],
      }),
    ).toEqual({ retell: { 'en-US': 'ok-voice' } });
  });
  it('treats a non-object as empty', () => {
    expect(parseVoiceOverrides('[]')).toEqual({});
    expect(parseVoiceOverrides([1, 2])).toEqual({});
  });
});

describe('VoiceOverrideInput', () => {
  const ok = {
    engine: 'retell',
    locale: 'en-US',
    voiceId: 'voice-1',
    evidence: 'Provisioned on Retell 28 Sep, consent ref A-12',
  };
  it('accepts a valid override and a clearing null', () => {
    expect(VoiceOverrideInput.safeParse(ok).success).toBe(true);
    expect(VoiceOverrideInput.safeParse({ ...ok, voiceId: null }).success).toBe(true);
  });
  it.each([
    ['an unknown engine', { engine: 'nope' }],
    ['an unknown locale', { locale: 'xx-XX' }],
    ['a voice id with a quote', { voiceId: 'a"b' }],
    ['a voice id with a space', { voiceId: 'a b' }],
    ['a note too short to mean anything', { evidence: 'ok' }],
  ])('refuses %s', (_why, over) => {
    expect(VoiceOverrideInput.safeParse({ ...ok, ...over }).success).toBe(false);
  });
});
