import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { contextFromEnv } from '../../src/runtime/context-from-env.js';

describe('contextFromEnv', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('reads all LOOM_* env vars', async () => {
    const env = {
      LOOM_AGENT_ID: 'ratchet',
      LOOM_SESSION_ID: 'abc-123',
      LOOM_ROLE: 'writer',
      LOOM_WORKTREE: '/tmp/test-worktree',
      LOOM_BRANCH: 'loom/test',
      LOOM_SCOPE: 'src/**,tests/**',
      LOOM_SCOPE_DENIED: 'secrets/**',
    };

    const ctx = await contextFromEnv(env);

    expect(ctx.agentId).toBe('ratchet');
    expect(ctx.sessionId).toBe('abc-123');
    expect(ctx.role).toBe('writer');
    expect(ctx.worktree).toBe('/tmp/test-worktree');
    expect(ctx.branch).toBe('loom/test');
    expect(ctx.scope).toEqual(['src/**', 'tests/**']);
    expect(ctx.scopeDenied).toEqual(['secrets/**']);
  });

  it('defaults agentId to "unknown" and warns', async () => {
    const ctx = await contextFromEnv({
      LOOM_SESSION_ID: 'sid',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.agentId).toBe('unknown');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('LOOM_AGENT_ID not set'),
    );
  });

  it('generates random sessionId and warns when missing', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_BRANCH: 'main',
    });

    // Should be a UUID-like string
    expect(ctx.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('LOOM_SESSION_ID not set'),
    );
  });

  it('defaults role to orchestrator', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.role).toBe('orchestrator');
  });

  it('falls back to writer for invalid role and warns', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_ROLE: 'superadmin',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.role).toBe('writer');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("LOOM_ROLE 'superadmin' is not a valid role"),
    );
  });

  it('defaults to orchestrator when LOOM_ROLE is empty string', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_ROLE: '',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.role).toBe('orchestrator');
  });

  it('accepts all valid roles', async () => {
    for (const role of ['writer', 'reviewer', 'orchestrator']) {
      const ctx = await contextFromEnv({
        LOOM_AGENT_ID: 'test',
        LOOM_SESSION_ID: 'sid',
        LOOM_ROLE: role,
        LOOM_BRANCH: 'main',
      });
      expect(ctx.role).toBe(role);
    }
  });

  it('defaults scope and scopeDenied to empty arrays', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.scope).toEqual([]);
    expect(ctx.scopeDenied).toEqual([]);
  });

  it('handles empty scope string', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_SCOPE: '',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.scope).toEqual([]);
  });

  it('trims whitespace from scope entries', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_SCOPE: ' src/** , tests/** , ',
      LOOM_BRANCH: 'main',
    });

    expect(ctx.scope).toEqual(['src/**', 'tests/**']);
  });

  it('emit is a no-op function', async () => {
    const ctx = await contextFromEnv({
      LOOM_AGENT_ID: 'test',
      LOOM_SESSION_ID: 'sid',
      LOOM_BRANCH: 'main',
    });

    // Should not throw
    await ctx.emit({
      type: 'state-changed',
      branch: 'main',
      agentId: 'test',
      sessionId: 'sid',
      timestamp: new Date().toISOString(),
      payload: {},
    });
  });
});
