import { describe, it, expect } from 'vitest';
import { parseTrailers } from '../../src/util/trailers.js';

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
