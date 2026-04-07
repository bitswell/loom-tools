import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { dispatchTool } from '../../src/tools/dispatch.js';

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

describe('dispatch tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a worktree for the specified branch', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '', exitCode: 0 }) // rev-parse --verify
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // worktree add

    const result = await dispatchTool.handler(
      {
        agentId: 'ratchet',
        worktreePath: '/tmp/agents/ratchet',
        phase: 'implementation',
        branch: 'loom/ratchet-task',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worktreePath).toBe('/tmp/agents/ratchet');
      expect(result.data.branch).toBe('loom/ratchet-task');
      expect(result.data.agentId).toBe('ratchet');
      expect(result.data.phase).toBe('implementation');
    }
  });

  it('defaults branch to loom/<agentId> if not specified', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const result = await dispatchTool.handler(
      {
        agentId: 'moss',
        worktreePath: '/tmp/agents/moss',
        phase: 'planning',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch).toBe('loom/moss');
    }

    // Branch verification should use the default
    expect(mockExec.mock.calls[0][1]).toContain('loom/moss');
  });

  it('returns error if branch does not exist', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a valid ref',
      exitCode: 128,
    });

    const result = await dispatchTool.handler(
      {
        agentId: 'ratchet',
        worktreePath: '/tmp/agents/ratchet',
        phase: 'implementation',
        branch: 'loom/nonexistent',
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('branch-not-found');
    }
  });

  it('handles already checked out worktree gracefully', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // branch exists
      .mockResolvedValueOnce({
        stdout: '',
        stderr: "fatal: 'loom/ratchet' is already checked out",
        exitCode: 128,
      }); // worktree already exists

    const result = await dispatchTool.handler(
      {
        agentId: 'ratchet',
        worktreePath: '/tmp/agents/ratchet',
        phase: 'implementation',
        branch: 'loom/ratchet',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
  });

  it('returns error on worktree creation failure', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'fatal: some other error',
        exitCode: 128,
      });

    const result = await dispatchTool.handler(
      {
        agentId: 'ratchet',
        worktreePath: '/tmp/agents/ratchet',
        phase: 'implementation',
        branch: 'loom/ratchet',
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('worktree-failed');
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(dispatchTool.definition.roles).toEqual(['orchestrator']);
  });
});
