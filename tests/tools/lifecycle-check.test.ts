import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  lifecycleCheckTool,
  transition,
  type LifecycleState,
  type TaskStatus,
} from '../../src/tools/lifecycle-check.js';
import type { ToolContext } from '../../src/types/context.js';
import {
  createFixtureRepo,
  assigned,
  type FixtureRepo,
  type CommitOpts,
} from '../harness/index.js';

function makeCtx(worktree: string): ToolContext {
  return {
    agentId: 'test',
    sessionId: 'test-session',
    role: 'writer',
    branch: 'loom/test',
    worktree,
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

const DEFAULT_AGENT = 'ratchet';
const DEFAULT_SESSION = '00000000-0000-0000-0000-000000000001';

/** Shorthand trailer builder: always includes Agent-Id + Session-Id. */
function trailers(
  extra: Record<string, string | string[]> = {},
): Record<string, string | string[]> {
  return {
    'Agent-Id': DEFAULT_AGENT,
    'Session-Id': DEFAULT_SESSION,
    ...extra,
  };
}

/** Seed a repo with a `main` branch that has a `base.txt` commit. */
async function seedBase(repo: FixtureRepo): Promise<void> {
  await repo.commit({
    subject: 'base: seed',
    files: { 'base.txt': 'hello\n' },
  });
}

/**
 * Build a LOOM branch on top of main: seed base, branch out, commit
 * the supplied sequence on the new branch, and return the branch name.
 */
async function buildBranch(
  repo: FixtureRepo,
  name: string,
  commits: CommitOpts[],
): Promise<string> {
  await seedBase(repo);
  await repo.branch(name);
  await repo.checkout(name);
  for (const c of commits) {
    await repo.commit(c);
  }
  return name;
}

async function runCheck(
  repo: FixtureRepo,
  branch: string,
  base: string = 'main',
  opts: { heartbeatWarnSec?: number; heartbeatErrorSec?: number } = {},
) {
  const result = await lifecycleCheckTool.handler(
    { branch, base, ...opts },
    makeCtx(repo.path),
  );
  if (!result.success) {
    throw new Error(`lifecycle-check failed: ${result.error.message}`);
  }
  return result.data;
}

function ruleIds(violations: Array<{ rule: string }>): string[] {
  return violations.map((v) => v.rule);
}

// ---------- Unit tests on transition() ----------

describe('lifecycle transition() pure function', () => {
  it('U1: START -> ASSIGNED is legal', () => {
    const r = transition('START', 'ASSIGNED');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toBe('ASSIGNED');
  });

  it('U2: START -> PLANNING is illegal', () => {
    const r = transition('START', 'PLANNING');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/illegal transition START -> PLANNING/);
  });

  it('U3: every legal edge returns ok', () => {
    const legalEdges: Array<[LifecycleState, TaskStatus]> = [
      ['START', 'ASSIGNED'],
      ['ASSIGNED', 'PLANNING'],
      ['PLANNING', 'IMPLEMENTING'],
      ['PLANNING', 'BLOCKED'],
      ['PLANNING', 'FAILED'],
      ['IMPLEMENTING', 'IMPLEMENTING'],
      ['IMPLEMENTING', 'BLOCKED'],
      ['IMPLEMENTING', 'COMPLETED'],
      ['IMPLEMENTING', 'FAILED'],
      ['BLOCKED', 'IMPLEMENTING'],
      ['BLOCKED', 'FAILED'],
    ];
    for (const [from, to] of legalEdges) {
      const r = transition(from, to);
      expect(r.ok, `${from} -> ${to} should be legal`).toBe(true);
    }
  });

  it('U4: every illegal edge returns !ok with a non-empty error', () => {
    const illegalEdges: Array<[LifecycleState, TaskStatus]> = [
      ['START', 'PLANNING'],
      ['START', 'IMPLEMENTING'],
      ['START', 'COMPLETED'],
      ['ASSIGNED', 'IMPLEMENTING'],
      ['ASSIGNED', 'COMPLETED'],
      ['PLANNING', 'COMPLETED'],
      ['PLANNING', 'ASSIGNED'],
      ['IMPLEMENTING', 'ASSIGNED'],
      ['IMPLEMENTING', 'PLANNING'],
      ['BLOCKED', 'COMPLETED'],
      ['BLOCKED', 'PLANNING'],
    ];
    for (const [from, to] of illegalEdges) {
      const r = transition(from, to);
      expect(r.ok, `${from} -> ${to} should be illegal`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('U5: transitions out of terminal states are always illegal', () => {
    const terminals: LifecycleState[] = ['COMPLETED', 'FAILED'];
    const allNext: TaskStatus[] = [
      'ASSIGNED',
      'PLANNING',
      'IMPLEMENTING',
      'COMPLETED',
      'BLOCKED',
      'FAILED',
    ];
    for (const t of terminals) {
      for (const n of allNext) {
        const r = transition(t, n);
        expect(r.ok, `${t} -> ${n} must be illegal`).toBe(false);
      }
    }
  });
});

// ---------- Fixture-based tests ----------

describe('lifecycle-check tool (branch walks)', () => {
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

  it('P1: minimal valid ASSIGNED -> PLANNING -> IMPLEMENTING -> COMPLETED', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p1', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p1', scope: 'src/**' }),
      {
        subject: 'chore(tools): plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'chore(tools): begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'chore(tools): complete',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '3',
          'Key-Finding': 'done',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p1');
    expect(data.ok).toBe(true);
    expect(data.violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('P2: multiple IMPLEMENTING heartbeats within warnSec', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p2', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p2', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'more work',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:05:00Z',
        }),
      },
      {
        subject: 'still going',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:10:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p2');
    expect(data.ok).toBe(true);
    expect(ruleIds(data.violations)).not.toContain('lifecycle-heartbeat-gap-warn');
    expect(ruleIds(data.violations)).not.toContain('lifecycle-heartbeat-gap-error');
  });

  it('P3: BLOCKED recovery — ASSIGNED -> PLANNING -> IMPLEMENTING -> BLOCKED -> IMPLEMENTING -> COMPLETED', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p3', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p3', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'blocked',
        trailers: trailers({
          'Task-Status': 'BLOCKED',
          'Blocked-Reason': 'resource_limit',
        }),
      },
      {
        subject: 'resume',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T01:00:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '2',
          'Key-Finding': 'unblocked',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p3');
    expect(data.ok).toBe(true);
    // Heartbeat window resets on BLOCKED -> IMPLEMENTING re-entry,
    // so the 1-hour gap across the BLOCKED transition is NOT flagged.
    expect(ruleIds(data.violations)).not.toContain(
      'lifecycle-heartbeat-gap-error',
    );
  });

  it('P4: terminal FAILED via PLANNING -> FAILED', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p4', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p4', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'fail',
        trailers: trailers({
          'Task-Status': 'FAILED',
          'Error-Category': 'internal',
          'Error-Retryable': 'false',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p4');
    expect(data.ok).toBe(true);
  });

  it('P5: heartbeat gap just under warnSec is accepted', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p5', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p5', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        // 299 seconds later, warnSec=300
        subject: 'just under',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:04:59Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'ok',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p5', 'main', {
      heartbeatWarnSec: 300,
      heartbeatErrorSec: 600,
    });
    expect(data.ok).toBe(true);
    expect(ruleIds(data.violations)).not.toContain('lifecycle-heartbeat-gap-warn');
  });

  it('P6: non-Task-Status work commits interspersed are fine', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p6', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p6', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'work: tweak thing',
        trailers: trailers({}),
        files: { 'work1.txt': 'a' },
      },
      {
        subject: 'work: another tweak',
        trailers: trailers({}),
        files: { 'work2.txt': 'b' },
      },
      {
        subject: 'checkpoint',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:05:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '3',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p6');
    expect(data.ok).toBe(true);
  });

  it('P7: COMPLETED with multi-Key-Finding is lifecycle-clean', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p7', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p7', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '10',
          'Key-Finding': ['alpha', 'beta', 'gamma'],
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/p7');
    expect(data.ok).toBe(true);
  });

  it('P8: single ASSIGNED commit — no terminal required', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p8', [
      assigned({ agent: DEFAULT_AGENT, slug: 'p8', scope: 'src/**' }),
    ]);
    const data = await runCheck(repo, 'loom/p8');
    // lifecycle-check does not require branches to be completed;
    // an ASSIGNED-only branch is legal mid-stream.
    expect(data.ok).toBe(true);
    expect(ruleIds(data.violations)).not.toContain('lifecycle-missing-assigned');
  });

  // ---------- Negative cases ----------

  it('N1: no ASSIGNED commit -> lifecycle-missing-assigned', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n1', [
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n1');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-missing-assigned');
  });

  it('N2: two ASSIGNED commits -> lifecycle-multiple-assigned', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n2', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n2a', scope: 'src/**' }),
      assigned({ agent: DEFAULT_AGENT, slug: 'n2b', scope: 'src/**' }),
    ]);
    const data = await runCheck(repo, 'loom/n2');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-multiple-assigned');
  });

  it('N3: PLANNING -> COMPLETED -> lifecycle-illegal-transition', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n3', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n3', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'skip to done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n3');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-illegal-transition');
  });

  it('N4: ASSIGNED -> IMPLEMENTING -> lifecycle-illegal-transition', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n4', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n4', scope: 'src/**' }),
      {
        subject: 'begin without planning',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n4');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-illegal-transition');
  });

  it('N5: COMPLETED -> IMPLEMENTING -> lifecycle-post-terminal', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n5', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n5', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
      {
        subject: 'more work after done',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:10:00Z',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n5');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-post-terminal');
  });

  it('N6: two COMPLETED commits -> lifecycle-multiple-completed', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n6', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n6', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'first done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
      {
        subject: 'second done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '2',
          'Key-Finding': 'k2',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n6');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-multiple-completed');
  });

  it('N7: IMPLEMENTING heartbeat gap > warnSec, <= errorSec -> lifecycle-heartbeat-gap-warn', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n7', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n7', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        // 400 seconds later; warnSec=300, errorSec=600
        subject: 'slow',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:06:40Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n7', 'main', {
      heartbeatWarnSec: 300,
      heartbeatErrorSec: 600,
    });
    const ids = ruleIds(data.violations);
    expect(ids).toContain('lifecycle-heartbeat-gap-warn');
    expect(ids).not.toContain('lifecycle-heartbeat-gap-error');
    // warn-only: overall ok stays true
    expect(data.ok).toBe(true);
  });

  it('N8: IMPLEMENTING heartbeat gap > errorSec -> lifecycle-heartbeat-gap-error', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n8', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n8', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        // 1 hour later; warnSec=300, errorSec=600
        subject: 'way too slow',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T01:00:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n8', 'main', {
      heartbeatWarnSec: 300,
      heartbeatErrorSec: 600,
    });
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-heartbeat-gap-error');
  });

  it('N9: IMPLEMENTING commit lacks Heartbeat -> lifecycle-heartbeat-missing', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n9', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n9', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin without heartbeat',
        trailers: trailers({ 'Task-Status': 'IMPLEMENTING' }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/n9');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-heartbeat-missing');
  });

  it('N10: plain work commit after COMPLETED -> lifecycle-post-terminal', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n10', [
      assigned({ agent: DEFAULT_AGENT, slug: 'n10', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
      {
        // Plain work commit, no Task-Status
        subject: 'oops, one more tweak',
        trailers: trailers({}),
        files: { 'after.txt': 'after' },
      },
    ]);
    const data = await runCheck(repo, 'loom/n10');
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('lifecycle-post-terminal');
  });

  // ---------- Sanity: transitions[] ordering ----------

  it('S1: transitions[] matches expected sequence for minimal valid branch', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/s1', [
      assigned({ agent: DEFAULT_AGENT, slug: 's1', scope: 'src/**' }),
      {
        subject: 'plan',
        trailers: trailers({ 'Task-Status': 'PLANNING' }),
      },
      {
        subject: 'begin',
        trailers: trailers({
          'Task-Status': 'IMPLEMENTING',
          Heartbeat: '2026-04-09T00:00:00Z',
        }),
      },
      {
        subject: 'done',
        trailers: trailers({
          'Task-Status': 'COMPLETED',
          'Files-Changed': '1',
          'Key-Finding': 'k',
        }),
      },
    ]);
    const data = await runCheck(repo, 'loom/s1');
    expect(data.ok).toBe(true);
    expect(data.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'START->ASSIGNED',
      'ASSIGNED->PLANNING',
      'PLANNING->IMPLEMENTING',
      'IMPLEMENTING->COMPLETED',
    ]);
  });
});
