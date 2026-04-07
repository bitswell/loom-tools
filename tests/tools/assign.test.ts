import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { assignTool } from '../../src/tools/assign.js';

vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'bitswell',
    sessionId: 'orch-session',
    role: 'orchestrator',
    branch: 'main',
    worktree: '/tmp/worktree',
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
    ...overrides,
  };
}

describe('assign tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an ASSIGNED commit on the target branch', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '', exitCode: 0 }); // rev-parse

    const result = await assignTool.handler(
      {
        agentId: 'ratchet',
        branch: 'loom/ratchet-task',
        taskBody: 'task(loom): do the thing',
        scope: 'src/',
        budget: 50000,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sha).toBe('abc123');
      expect(result.data.branch).toBe('loom/ratchet-task');
    }
  });

  it('includes required trailers in the commit command', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
      .mockResolvedValueOnce({ stdout: 'sha1\n', stderr: '', exitCode: 0 }); // rev-parse

    await assignTool.handler(
      {
        agentId: 'ratchet',
        branch: 'loom/ratchet-task',
        taskBody: 'task body',
        scope: 'src/',
        dependencies: 'bitswell/phase-2',
        budget: 100,
      },
      ctx,
    );

    // The commit call is the second exec call
    const commitCall = mockExec.mock.calls[1];
    const args = commitCall[1];
    expect(args).toContain('--allow-empty');
    expect(args.join(' ')).toContain('Task-Status: ASSIGNED');
    expect(args.join(' ')).toContain('Assigned-To: ratchet');
    expect(args.join(' ')).toContain('Scope: src/');
    expect(args.join(' ')).toContain('Dependencies: bitswell/phase-2');
    expect(args.join(' ')).toContain('Budget: 100');
  });

  it('creates branch if checkout fails', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 }) // checkout fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
      .mockResolvedValueOnce({ stdout: 'new-sha\n', stderr: '', exitCode: 0 }); // rev-parse

    const result = await assignTool.handler(
      {
        agentId: 'ratchet',
        branch: 'loom/new-branch',
        taskBody: 'new task',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // Second call should be checkout -b
    expect(mockExec.mock.calls[1][1]).toContain('-b');
  });

  it('returns error if both checkout and branch creation fail', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'err', exitCode: 1 }) // checkout
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal', exitCode: 128 }); // checkout -b

    const result = await assignTool.handler(
      {
        agentId: 'ratchet',
        branch: 'loom/bad',
        taskBody: 'task',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('branch-failed');
    }
  });

  it('emits state-changed event', async () => {
    const ctx = makeCtx();
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 });

    await assignTool.handler(
      {
        agentId: 'ratchet',
        branch: 'loom/task',
        taskBody: 'task',
      },
      ctx,
    );

    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state-changed',
        payload: expect.objectContaining({
          status: 'ASSIGNED',
          assignedTo: 'ratchet',
        }),
      }),
    );
  });

  it('is scoped to orchestrator role only', () => {
    expect(assignTool.definition.roles).toEqual(['orchestrator']);
  });
});
