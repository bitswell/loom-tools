import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { statusTool, STALE_THRESHOLD_MS } from '../../src/tools/status.js';

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

describe('status tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rich agent status for loom branches', async () => {
    const recentHeartbeat = new Date().toISOString();
    mockExec
      .mockResolvedValueOnce({
        stdout: 'loom/ratchet\nloom/moss\n',
        stderr: '',
        exitCode: 0,
      }) // branch list
      .mockResolvedValueOnce({
        stdout: `Agent-Id: ratchet\nAssignment: bitswell/task-1\nTask-Status: IMPLEMENTING\nHeartbeat: ${recentHeartbeat}\n`,
        stderr: '',
        exitCode: 0,
      }) // ratchet trailers
      .mockResolvedValueOnce({
        stdout: `Agent-Id: moss\nTask-Status: COMPLETED\nHeartbeat: 2025-01-01T00:00:00Z\n`,
        stderr: '',
        exitCode: 0,
      }); // moss trailers

    const result = await statusTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toHaveLength(2);

      const ratchet = result.data.agents.find((a) => a.branch === 'loom/ratchet');
      expect(ratchet?.agentId).toBe('ratchet');
      expect(ratchet?.assignment).toBe('bitswell/task-1');
      expect(ratchet?.status).toBe('IMPLEMENTING');
      expect(ratchet?.stale).toBe(false);
      expect(ratchet?.timeSinceHeartbeatMs).toBeDefined();

      const moss = result.data.agents.find((a) => a.branch === 'loom/moss');
      expect(moss?.agentId).toBe('moss');
      expect(moss?.status).toBe('COMPLETED');
      expect(moss?.stale).toBe(true);
    }
  });

  it('handles branches with no trailers', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'loom/empty\n',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: '\n',
        stderr: '',
        exitCode: 0,
      });

    const result = await statusTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents[0].stale).toBe(false);
      expect(result.data.agents[0].agentId).toBeUndefined();
    }
  });

  it('returns error on git failure', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: bad ref',
      exitCode: 128,
    });

    const result = await statusTool.handler({}, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('git-branch-failed');
    }
  });

  it('returns empty array when no branches match', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const result = await statusTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toHaveLength(0);
    }
  });

  it('uses custom pattern', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await statusTool.handler({ pattern: 'loom/ratchet-*' }, makeCtx());

    expect(mockExec.mock.calls[0][1]).toContain('refs/heads/loom/ratchet-*');
  });

  it('staleness threshold is 5 minutes', () => {
    expect(STALE_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it('is scoped to orchestrator role only', () => {
    expect(statusTool.definition.roles).toEqual(['orchestrator']);
  });
});
