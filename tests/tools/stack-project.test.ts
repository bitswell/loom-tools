import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { stackProjectTool } from '../../src/tools/stack-project.js';

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

const threeLayers = [
  { agent: 'ratchet', slug: 'one', branch: 'loom/ratchet-one' },
  { agent: 'moss', slug: 'two', branch: 'loom/moss-two' },
  { agent: 'ratchet', slug: 'three', branch: 'loom/ratchet-three' },
];

function ok(stdout = '') {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr = 'boom') {
  return { stdout: '', stderr, exitCode: 1 };
}

/**
 * Queue the exec calls for a successful per-layer mirror build:
 *   rev-list, branch -f, checkout, cherry-pick
 * Each layer has one commit on top of base, so cherry-pick is invoked.
 */
function queueLayerSuccess(commitSha: string) {
  mockExec.mockResolvedValueOnce(ok(`${commitSha}\n`)); // rev-list
  mockExec.mockResolvedValueOnce(ok()); // branch -f
  mockExec.mockResolvedValueOnce(ok()); // checkout
  mockExec.mockResolvedValueOnce(ok()); // cherry-pick
}

describe('stack-project tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds mirrors, adopts them into a stack, and submits PRs (happy path)', async () => {
    queueLayerSuccess('aaa1111');
    queueLayerSuccess('bbb2222');
    queueLayerSuccess('ccc3333');

    // gh stack init --adopt ...
    mockExec.mockResolvedValueOnce(ok('initialized\n'));
    // gh stack submit --auto --draft
    mockExec.mockResolvedValueOnce(
      ok(
        'Submitted https://github.com/owner/repo/pull/1 https://github.com/owner/repo/pull/2 https://github.com/owner/repo/pull/3\n',
      ),
    );

    const result = await stackProjectTool.handler(
      {
        epic: 'epic-x',
        order: threeLayers,
        base: 'main',
        draft: true,
        reproject: false,
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mirrorBranches).toEqual([
        'stack/epic-x/01-ratchet-one',
        'stack/epic-x/02-moss-two',
        'stack/epic-x/03-ratchet-three',
      ]);
      expect(result.data.prUrls).toEqual([
        'https://github.com/owner/repo/pull/1',
        'https://github.com/owner/repo/pull/2',
        'https://github.com/owner/repo/pull/3',
      ]);
    }

    // Validate that the second mirror was force-branched onto the first mirror.
    const branchForceCalls = mockExec.mock.calls.filter(
      (c) => c[0] === 'git' && c[1][0] === 'branch' && c[1][1] === '-f',
    );
    expect(branchForceCalls[0][1]).toEqual([
      'branch',
      '-f',
      'stack/epic-x/01-ratchet-one',
      'main',
    ]);
    expect(branchForceCalls[1][1]).toEqual([
      'branch',
      '-f',
      'stack/epic-x/02-moss-two',
      'stack/epic-x/01-ratchet-one',
    ]);
    expect(branchForceCalls[2][1]).toEqual([
      'branch',
      '-f',
      'stack/epic-x/03-ratchet-three',
      'stack/epic-x/02-moss-two',
    ]);

    // gh stack init was called with --adopt and all three mirror branches.
    const initCall = mockExec.mock.calls.find(
      (c) => c[0] === 'gh' && c[1][0] === 'stack' && c[1][1] === 'init',
    );
    expect(initCall).toBeDefined();
    expect(initCall![1]).toEqual([
      'stack',
      'init',
      '--base',
      'main',
      '--adopt',
      'stack/epic-x/01-ratchet-one',
      'stack/epic-x/02-moss-two',
      'stack/epic-x/03-ratchet-three',
    ]);

    // submit was called with --draft.
    const submitCall = mockExec.mock.calls.find(
      (c) => c[0] === 'gh' && c[1][0] === 'stack' && c[1][1] === 'submit',
    );
    expect(submitCall).toBeDefined();
    expect(submitCall![1]).toContain('--auto');
    expect(submitCall![1]).toContain('--draft');
  });

  it('reproject=true invokes gh stack unstack as the first exec call', async () => {
    mockExec.mockResolvedValueOnce(ok('unstacked\n')); // gh stack unstack
    queueLayerSuccess('aaa1111');
    mockExec.mockResolvedValueOnce(ok('initialized\n'));
    mockExec.mockResolvedValueOnce(ok('https://github.com/owner/repo/pull/9\n'));

    const result = await stackProjectTool.handler(
      {
        epic: 'epic-y',
        order: [threeLayers[0]],
        base: 'main',
        draft: true,
        reproject: true,
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(mockExec.mock.calls[0][0]).toBe('gh');
    expect(mockExec.mock.calls[0][1]).toEqual(['stack', 'unstack']);
  });

  it('returns mirror-cherry-pick-failed and never calls gh stack init', async () => {
    // First layer: rev-list ok, branch ok, checkout ok, cherry-pick FAILS.
    mockExec.mockResolvedValueOnce(ok('aaa1111\n'));
    mockExec.mockResolvedValueOnce(ok());
    mockExec.mockResolvedValueOnce(ok());
    mockExec.mockResolvedValueOnce(fail('CONFLICT (content): Merge conflict in foo.txt'));

    const result = await stackProjectTool.handler(
      {
        epic: 'epic-z',
        order: [threeLayers[0]],
        base: 'main',
        draft: true,
        reproject: false,
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('mirror-cherry-pick-failed');
    }

    const initCall = mockExec.mock.calls.find(
      (c) => c[0] === 'gh' && c[1][0] === 'stack' && c[1][1] === 'init',
    );
    expect(initCall).toBeUndefined();
  });

  it('returns stack-init-failed and never calls gh stack submit', async () => {
    queueLayerSuccess('aaa1111');
    mockExec.mockResolvedValueOnce(fail('not a stack repo'));

    const result = await stackProjectTool.handler(
      {
        epic: 'epic-z',
        order: [threeLayers[0]],
        base: 'main',
        draft: true,
        reproject: false,
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('stack-init-failed');
    }

    const submitCall = mockExec.mock.calls.find(
      (c) => c[0] === 'gh' && c[1][0] === 'stack' && c[1][1] === 'submit',
    );
    expect(submitCall).toBeUndefined();
  });

  it('omits --draft from submit when draft=false', async () => {
    queueLayerSuccess('aaa1111');
    mockExec.mockResolvedValueOnce(ok('initialized\n'));
    mockExec.mockResolvedValueOnce(ok('https://github.com/owner/repo/pull/1\n'));

    const result = await stackProjectTool.handler(
      {
        epic: 'epic-x',
        order: [threeLayers[0]],
        base: 'main',
        draft: false,
        reproject: false,
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const submitCall = mockExec.mock.calls.find(
      (c) => c[0] === 'gh' && c[1][0] === 'stack' && c[1][1] === 'submit',
    );
    expect(submitCall).toBeDefined();
    expect(submitCall![1]).toContain('--auto');
    expect(submitCall![1]).not.toContain('--draft');
  });

  it('is scoped to orchestrator role only', () => {
    expect(stackProjectTool.definition.roles).toEqual(['orchestrator']);
  });
});
