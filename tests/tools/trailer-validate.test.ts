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
        'Dependencies': 'none',
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

  // ---------- ASSIGNED-commit rules ----------

  it('P-ASSIGNED: accepts ASSIGNED with all five required trailers', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'task(loom): assigned valid',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'build-widget',
        'Scope': 'src/**',
        'Dependencies': 'none',
        'Budget': '5000',
      },
    });
    expect(data.ok).toBe(true);
    expect(data.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('N-ASSIGNED: flags missing Assigned-To', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assignment': 'build-widget',
        'Scope': 'src/**',
        'Dependencies': 'none',
        'Budget': '5000',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('assigned-to-required');
  });

  it('N-ASSIGNED: flags missing Assignment', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Scope': 'src/**',
        'Dependencies': 'none',
        'Budget': '5000',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('assignment-required');
  });

  it('N-ASSIGNED: flags missing Scope', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'build-widget',
        'Dependencies': 'none',
        'Budget': '5000',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('scope-required');
  });

  it('N-ASSIGNED: flags missing Dependencies', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'build-widget',
        'Scope': 'src/**',
        'Budget': '5000',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('dependencies-required');
  });

  it('N-ASSIGNED: flags missing Budget', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'build-widget',
        'Scope': 'src/**',
        'Dependencies': 'none',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('budget-required');
  });

  it('N-ASSIGNED: flags negative Budget', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'build-widget',
        'Scope': 'src/**',
        'Dependencies': 'none',
        'Budget': '-5',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('budget-required');
  });

  it('N-ASSIGNED: flags non-integer Budget', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'ASSIGNED',
        'Assigned-To': 'ratchet',
        'Assignment': 'build-widget',
        'Scope': 'src/**',
        'Dependencies': 'none',
        'Budget': 'abc',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('budget-required');
  });

  // ---------- Terminal-state Heartbeat rules ----------

  it('P-COMPLETED-HB: accepts COMPLETED with Heartbeat', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'task(loom): done',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
        'Task-Status': 'COMPLETED',
        'Files-Changed': '2',
        'Key-Finding': 'all good',
        'Heartbeat': '2026-04-08T12:00:00Z',
      },
    });
    expect(data.ok).toBe(true);
    expect(
      data.violations.filter((v) => v.rule === 'heartbeat-missing'),
    ).toEqual([]);
  });

  it('P-BLOCKED-HB: accepts BLOCKED with Heartbeat', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'task(loom): blocked',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
        'Task-Status': 'BLOCKED',
        'Blocked-Reason': 'waiting on upstream',
        'Heartbeat': '2026-04-08T12:00:00Z',
      },
    });
    expect(data.ok).toBe(true);
    expect(
      data.violations.filter((v) => v.rule === 'heartbeat-missing'),
    ).toEqual([]);
  });

  it('P-FAILED-HB: accepts FAILED with Heartbeat', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'task(loom): failed',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
        'Task-Status': 'FAILED',
        'Error-Category': 'internal',
        'Error-Retryable': 'false',
        'Heartbeat': '2026-04-08T12:00:00Z',
      },
    });
    expect(data.ok).toBe(true);
    expect(
      data.violations.filter((v) => v.rule === 'heartbeat-missing'),
    ).toEqual([]);
  });

  it('N-COMPLETED-HB: warns on COMPLETED without Heartbeat (non-strict)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'COMPLETED',
        'Files-Changed': '1',
        'Key-Finding': 'done',
      },
    });
    expect(data.ok).toBe(true);
    const missing = data.violations.find(
      (v) => v.rule === 'heartbeat-missing',
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('warn');
  });

  it('N-COMPLETED-HB-STRICT: errors on COMPLETED without Heartbeat (strict)', async () => {
    const repo = await fresh();
    const data = await runValidate(
      repo,
      {
        subject: 'test',
        trailers: {
          'Agent-Id': 'moss',
          'Session-Id': 'abc',
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'done',
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

  it('N-BLOCKED-HB: warns on BLOCKED without Heartbeat (non-strict)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'BLOCKED',
        'Blocked-Reason': 'waiting',
      },
    });
    expect(data.ok).toBe(true);
    const missing = data.violations.find(
      (v) => v.rule === 'heartbeat-missing',
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('warn');
  });

  it('N-FAILED-HB: warns on FAILED without Heartbeat (non-strict)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Task-Status': 'FAILED',
        'Error-Category': 'blocked',
        'Error-Retryable': 'true',
      },
    });
    expect(data.ok).toBe(true);
    const missing = data.violations.find(
      (v) => v.rule === 'heartbeat-missing',
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('warn');
  });

  // ---------- Scope-Expand format rules ----------

  it('P-SE1: accepts one valid Scope-Expand', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test: scope expand',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
        'Scope-Expand': 'src/foo.ts -- needed for type export',
      },
    });
    expect(data.ok).toBe(true);
    expect(ruleIds(data.violations)).not.toContain('scope-expand-format');
  });

  it('P-SE2: accepts two valid Scope-Expand trailers', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test: multi scope expand',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
        'Scope-Expand': [
          'src/foo.ts -- needed for type export',
          'src/bar.ts -- shared utility',
        ],
      },
    });
    expect(data.ok).toBe(true);
    expect(ruleIds(data.violations)).not.toContain('scope-expand-format');
  });

  it('P-SE3: accepts commit with no Scope-Expand (optional)', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test: no scope expand',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc-123',
      },
    });
    expect(data.ok).toBe(true);
    expect(ruleIds(data.violations)).not.toContain('scope-expand-format');
  });

  it('N-SE1: flags Scope-Expand without -- separator', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Scope-Expand': 'src/foo.ts',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('scope-expand-format');
  });

  it('N-SE2: flags Scope-Expand with empty path', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Scope-Expand': ' -- some reason',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('scope-expand-format');
  });

  it('N-SE3: flags Scope-Expand with empty reason after --', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Scope-Expand': 'src/foo.ts --',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('scope-expand-format');
  });

  it('N-SE4: flags Scope-Expand with whitespace-only reason', async () => {
    const repo = await fresh();
    const data = await runValidate(repo, {
      subject: 'test',
      trailers: {
        'Agent-Id': 'moss',
        'Session-Id': 'abc',
        'Scope-Expand': 'src/foo.ts --  ',
      },
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('scope-expand-format');
  });
});
