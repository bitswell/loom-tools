import { describe, it, expect } from 'vitest';
import { ok, err } from '../../src/types/result.js';

describe('ok', () => {
  it('creates a success result', () => {
    const result = ok({ bmi: 22.5 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ bmi: 22.5 });
  });

  it('works with primitive data', () => {
    const result = ok('done');
    expect(result.success).toBe(true);
    expect(result.data).toBe('done');
  });
});

describe('err', () => {
  it('creates an error result', () => {
    const result = err('scope-violation', 'File outside scope', false);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('scope-violation');
    expect(result.error.message).toBe('File outside scope');
    expect(result.error.retryable).toBe(false);
  });

  it('defaults retryable to false', () => {
    const result = err('internal', 'something broke');
    expect(result.error.retryable).toBe(false);
  });

  it('accepts retryable true', () => {
    const result = err('compile-failed', 'syntax error', true);
    expect(result.error.retryable).toBe(true);
  });
});
