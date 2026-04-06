import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { commitTool } from '../../src/tools/commit.js';

// Mock exec
vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'ratchet',
    sessionId: 'test-session',
    role: 'writer',
    branch: 'loom/ratchet-fix',
    worktree: '/tmp/worktree',
    scope: ['src/'],
    scopeDenied: [],
    emit: vi.fn(),
    ...overrides,
  };
}

describe('commit tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects files outside scope', async () => {
    const ctx = makeCtx();
    const result = await commitTool.handler(
      { message: 'test', files: ['dist/out.js'] },
      ctx,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('scope-violation');
      expect(result.error.message).toContain('dist/out.js');
    }
    // Should emit scope-violation event
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scope-violation' }),
    );
  });

  it('allows files within scope', async () => {
    const ctx = makeCtx();
    // Mock successful git add, commit, and rev-parse
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit (signed)
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '', exitCode: 0 }); // git rev-parse

    const result = await commitTool.handler(
      { message: 'feat: add thing', files: ['src/foo.ts'] },
      ctx,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sha).toBe('abc123');
      expect(result.data.trailers['Agent-Id']).toBe('ratchet');
      expect(result.data.trailers['Session-Id']).toBe('test-session');
      expect(result.data.trailers['Heartbeat']).toBeDefined();
    }
  });

  it('injects custom trailers alongside auto-injected ones', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
      .mockResolvedValueOnce({ stdout: 'def456\n', stderr: '', exitCode: 0 }); // rev-parse

    const result = await commitTool.handler(
      {
        message: 'feat: thing',
        files: ['src/a.ts'],
        trailers: { 'Task-Status': 'IMPLEMENTING', 'Key-Finding': 'works' },
      },
      ctx,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trailers['Task-Status']).toBe('IMPLEMENTING');
      expect(result.data.trailers['Key-Finding']).toBe('works');
    }
  });

  it('emits state-changed when Task-Status trailer is present', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha789\n', stderr: '', exitCode: 0 });

    await commitTool.handler(
      {
        message: 'done',
        files: ['src/x.ts'],
        trailers: { 'Task-Status': 'COMPLETED' },
      },
      ctx,
    );

    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state-changed',
        payload: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('does not emit state-changed without Task-Status', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha000\n', stderr: '', exitCode: 0 });

    await commitTool.handler(
      { message: 'fix: thing', files: ['src/b.ts'] },
      ctx,
    );

    // Only the add call — no state-changed
    const emitCalls = vi.mocked(ctx.emit).mock.calls;
    const stateChangedCalls = emitCalls.filter(
      (c) => c[0].type === 'state-changed',
    );
    expect(stateChangedCalls).toHaveLength(0);
  });

  it('falls back to unsigned commit when signing fails', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: 'signing failed', exitCode: 1 }) // signed commit fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // unsigned commit
      .mockResolvedValueOnce({ stdout: 'fallback-sha\n', stderr: '', exitCode: 0 }); // rev-parse

    const result = await commitTool.handler(
      { message: 'fix: thing', files: ['src/a.ts'] },
      ctx,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sha).toBe('fallback-sha');
    }
  });

  it('returns error when both signed and unsigned commits fail', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: 'sign fail', exitCode: 1 }) // signed
      .mockResolvedValueOnce({ stdout: '', stderr: 'nothing to commit', exitCode: 1 }); // unsigned

    const result = await commitTool.handler(
      { message: 'fix: thing', files: ['src/a.ts'] },
      ctx,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('commit-failed');
    }
  });

  it('returns error when git add fails', async () => {
    const ctx = makeCtx();
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'pathspec not found',
      exitCode: 128,
    });

    const result = await commitTool.handler(
      { message: 'fix', files: ['src/nonexistent.ts'] },
      ctx,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('git-add-failed');
    }
  });

  it('commits with no files (whatever is staged)', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // signed commit
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '', exitCode: 0 }); // rev-parse

    const result = await commitTool.handler(
      { message: 'chore: update' },
      ctx,
    );
    expect(result.success).toBe(true);
    // No git add should have been called — first exec call should be the commit
    const firstCall = mockExec.mock.calls[0];
    expect(firstCall[0]).toBe('git');
    expect(firstCall[1]).toContain('commit');
  });

  it('rejects files in denied scope even if within allowed scope', async () => {
    const ctx = makeCtx({ scopeDenied: ['src/secrets/'] });
    const result = await commitTool.handler(
      { message: 'test', files: ['src/secrets/key.ts'] },
      ctx,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('scope-violation');
    }
  });
});
