import { describe, it, expect, afterEach, vi } from 'vitest';
import { trailerValidateTool } from '../../src/tools/trailer-validate.js';
import type { ToolContext } from '../../src/types/context.js';
import {
  createFixtureRepo,
  type FixtureRepo,
  type CommitOpts,
} from '../harness/index.js';

function makeCtx(worktree: string): ToolContext {
  return {
    agentId: 'test',
    sessionId: 'test-session',
    role: 'writer',
    branch: 'main',
    worktree,
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

async function runValidate(
  repo: FixtureRepo,
  commit: CommitOpts,
  strict = false,
) {
  await repo.commit(commit);
  const result = await trailerValidateTool.handler(
    { ref: 'HEAD', strict },
    makeCtx(repo.path),
  );
  if (!result.success) {
    throw new Error(`trailer-validate failed: ${result.error.message}`);
  }
  return result.data;
}

function ruleIds(violations: Array<{ rule: string }>): string[] {
  return violations.map((v) => v.rule);
}

describe('trailer-validate tool', () => {
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    while (repos.length > 0) {
      const r = repos.pop();
      if (r) await r.cleanup();
    }
  });

  async function fresh(): Promise<FixtureRepo> {
    const r = await createFixtureRepo();
    repos.push(r);
    return r;
  }

  // ---------- Positive cases ----------

  it('P1: accepts minimal valid (Agent-Id + Session-Id, no Task-Status)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test: minimal',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
      },
    });
    expect(data.ok).toBe(true);
    expect(data.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('P2: accepts a valid ASSIGNED commit', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'task(loom): do a thing',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'do-a-thing',
        'Scope': 'src/tools/**',
        'Budget': '60000',
      },
    });
    expect(data.ok).toBe(true);
  });

  it('P3: accepts a valid PLANNING commit', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'chore(tools): plan',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'PLANNING',
      },
    });
    expect(data.ok).toBe(true);
  });

  it('P4: accepts a valid IMPLEMENTING commit with Heartbeat', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'chore(tools): begin work',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'IMPLEMENTING',
        'Heartbeat': '2026-04-09T15:30:00Z',
      },
    });
    expect(data.ok).toBe(true);
    expect(
      data.violations.filter((v) => v.rule === 'heartbeat-missing'),
    ).toEqual([]);
  });

  it('P5: accepts COMPLETED with Files-Changed=0 and one Key-Finding', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'chore(tools): complete',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'COMPLETED',
        'Files-Changed': '0',
        'Key-Finding': 'no-op task, nothing to change',
      },
    });
    expect(data.ok).toBe(true);
  });

  it('P6: accepts COMPLETED with Files-Changed=5 and multiple Key-Finding trailers', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'chore(tools): complete multi',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'COMPLETED',
        'Files-Changed': '5',
        'Key-Finding': [
          'finding alpha',
          'finding beta',
          'finding gamma',
        ],
      },
    });
    expect(data.ok).toBe(true);
  });

  it('P7: accepts BLOCKED with Blocked-Reason', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'chore(tools): blocked',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'BLOCKED',
        'Blocked-Reason': 'resource_limit',
      },
    });
    expect(data.ok).toBe(true);
  });

  it('P8: accepts FAILED with Error-Category and Error-Retryable', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'chore(tools): failed',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc-123',
        'Task-Status': 'FAILED',
        'Error-Category': 'internal',
        'Error-Retryable': 'false',
      },
    });
    expect(data.ok).toBe(true);
  });

  // ---------- Negative cases ----------

  it('N1: flags missing Agent-Id', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: { 'Session-Id': 'abc' },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('agent-id-required');
  });

  it('N2: flags missing Session-Id', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: { 'Agent-Id': 'ratchet' },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('session-id-required');
  });

  it('N3: flags unknown Task-Status', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'WAT',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('task-status-enum');
  });

  it('N4: flags COMPLETED without Files-Changed (and without Key-Finding)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'COMPLETED',
      },
    });
    expect(data.ok).toBe(false);
    const ids = ruleIds(data.violations);
    expect(ids).toContain('completed-files-changed');
    expect(ids).toContain('completed-key-finding-required');
  });

  it('N5: flags COMPLETED with non-integer Files-Changed', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'COMPLETED',
        'Files-Changed': 'foo',
        'Key-Finding': 'one',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('completed-files-changed-int');
  });

  it('N6: flags COMPLETED without Key-Finding', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'COMPLETED',
        'Files-Changed': '3',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain(
      'completed-key-finding-required',
    );
  });

  it('N7: flags BLOCKED without Blocked-Reason', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'BLOCKED',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('blocked-reason-required');
  });

  it('N8: flags FAILED without Error-Category', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'FAILED',
        'Error-Retryable': 'true',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain(
      'failed-error-category-required',
    );
  });

  it('N9: flags FAILED with unknown Error-Category', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'FAILED',
        'Error-Category': 'nope',
        'Error-Retryable': 'true',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('failed-error-category-enum');
  });

  it('N10: flags FAILED without Error-Retryable', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'FAILED',
        'Error-Category': 'internal',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain(
      'failed-error-retryable-required',
    );
  });

  it('N11: flags Heartbeat with wrong format', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Heartbeat': '2026-04-08',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('heartbeat-format');
  });

  it('N12: strict mode makes missing Heartbeat on IMPLEMENTING an error', async () => {
    const repo = await fresh();
    const data = await runValidate(
      repo,
      {
        subject: 'test',
        trailers: {
          'Agent-Id': 'ratchet',
          'Session-Id': 'abc',
          'Task-Status': 'IMPLEMENTING',
        },
      },
      true,
    );
    expect(data.ok).toBe(false);
    const missing = data.violations.find(
      (v) => v.rule === 'heartbeat-missing',
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('error');
  });

  it('N13: non-strict mode makes missing Heartbeat on IMPLEMENTING a warn (ok=true)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'IMPLEMENTING',
      },
    });
    expect(data.ok).toBe(true);
    const missing = data.violations.find(
      (v) => v.rule === 'heartbeat-missing',
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('warn');
  });

  // ---------- Adjacent edge cases ----------

  it('A1: flags Files-Changed=-1 as non-integer', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'COMPLETED',
        'Files-Changed': '-1',
        'Key-Finding': 'one',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('completed-files-changed-int');
  });

  it('A2: flags Error-Retryable=maybe as non-bool', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'ratchet',
        'Session-Id': 'abc',
        'Task-Status': 'FAILED',
        'Error-Category': 'internal',
        'Error-Retryable': 'maybe',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('failed-error-retryable-bool');
  });
});
