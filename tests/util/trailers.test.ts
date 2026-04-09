import { describe, it, expect } from 'vitest';
import { parseTrailers, parseTrailersMulti } from '../../src/util/trailers.js';

describe('parseTrailers', () => {
  it('parses standard git trailers', () => {
    const raw = `Agent-Id: ratchet
Session-Id: abc-123
Task-Status: ASSIGNED`;
    const result = parseTrailers(raw);
    expect(result).toEqual({
      'Agent-Id': 'ratchet',
      'Session-Id': 'abc-123',
      'Task-Status': 'ASSIGNED',
    });
  });

  it('handles values containing colons', () => {
    const raw = 'Heartbeat: 2026-04-06T19:00:00Z';
    const result = parseTrailers(raw);
    expect(result['Heartbeat']).toBe('2026-04-06T19:00:00Z');
  });

  it('skips empty lines', () => {
    const raw = `Agent-Id: ratchet

Task-Status: COMPLETED
`;
    const result = parseTrailers(raw);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['Agent-Id']).toBe('ratchet');
    expect(result['Task-Status']).toBe('COMPLETED');
  });

  it('skips lines without colons', () => {
    const raw = `Agent-Id: ratchet
no colon here
Task-Status: COMPLETED`;
    const result = parseTrailers(raw);
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('trims whitespace from keys and values', () => {
    const raw = '  Agent-Id :  ratchet  ';
    const result = parseTrailers(raw);
    expect(result['Agent-Id']).toBe('ratchet');
  });

  it('returns empty record for empty input', () => {
    expect(parseTrailers('')).toEqual({});
  });

  it('skips lines with empty key or value', () => {
    const raw = `: value\nKey: `;
    const result = parseTrailers(raw);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('parseTrailersMulti', () => {
  it('parses a single-value trailer into a 1-element array', () => {
    const raw = 'Agent-Id: ratchet';
    const result = parseTrailersMulti(raw);
    expect(result).toEqual({ 'Agent-Id': ['ratchet'] });
  });

  it('collects repeated keys into an ordered array', () => {
    const raw = `Key-Finding: first
Key-Finding: second
Key-Finding: third`;
    const result = parseTrailersMulti(raw);
    expect(result['Key-Finding']).toEqual(['first', 'second', 'third']);
  });

  it('mixes repeated and unique keys correctly', () => {
    const raw = `Agent-Id: ratchet
Key-Finding: one
Session-Id: abc
Key-Finding: two`;
    const result = parseTrailersMulti(raw);
    expect(result).toEqual({
      'Agent-Id': ['ratchet'],
      'Session-Id': ['abc'],
      'Key-Finding': ['one', 'two'],
    });
  });

  it('returns empty record for empty input', () => {
    expect(parseTrailersMulti('')).toEqual({});
  });

  it('skips empty lines and lines without colons', () => {
    const raw = `Agent-Id: ratchet

no colon here
Task-Status: COMPLETED`;
    const result = parseTrailersMulti(raw);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['Agent-Id']).toEqual(['ratchet']);
    expect(result['Task-Status']).toEqual(['COMPLETED']);
  });

  it('trims whitespace from keys and values', () => {
    const raw = '  Agent-Id :  ratchet  ';
    const result = parseTrailersMulti(raw);
    expect(result['Agent-Id']).toEqual(['ratchet']);
  });

  it('preserves order of multiple values for the same key', () => {
    const raw = `Key-Finding: alpha
Key-Finding: beta
Key-Finding: gamma
Key-Finding: delta`;
    const result = parseTrailersMulti(raw);
    expect(result['Key-Finding']).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });
});
