import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchCheckTool } from '../../src/tools/dispatch-check.js';
import { trailerValidateTool } from '../../src/tools/trailer-validate.js';
import type { ToolContext } from '../../src/types/context.js';
import { exec } from '../../src/util/exec.js';

/**
 * dispatch-check is invoked without reading its ToolContext (the tool
 * takes the worktree path via input). makeCtx exists only to satisfy
 * the ToolHandler signature.
 */
function makeCtx(): ToolContext {
  return {
    agentId: 'test',
    sessionId: 'test-session',
    role: 'orchestrator',
    branch: 'main',
    worktree: '/nonexistent',
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await exec('git', args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

import { execFile } from 'node:child_process';

/**
 * Run git with a message piped on stdin (for commit -F -).
 */
function gitWithStdin(
  cwd: string,
  args: string[],
  input: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `git ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
    if (!child.stdin) {
      reject(new Error('git child process has no stdin'));
      return;
    }
    child.stdin.end(input);
  });
}

/**
 * Build a LOOM-shaped worktree at
 *   <tmp>/.loom/agents/<agent>/worktrees/<org>_<repo>_<slug>
 *
 * Returns the tmp parent (for cleanup) and the worktree path.
 *
 * The worktree is a real git repo (not a `git worktree add` checkout)
 * because that's all dispatch-check inspects — it runs git commands
 * with cwd = worktree and reads the sibling AGENT.json path. Using a
 * plain repo keeps the fixtures simple.
 */
interface LoomWorktree {
  parent: string;
  worktreePath: string;
  cleanup: () => Promise<void>;
}

async function createLoomWorktree(opts: {
  agent?: string;
  org?: string;
  repo?: string;
  slug: string;
  branch?: string;
}): Promise<LoomWorktree> {
  const agent = opts.agent ?? 'test';
  const org = opts.org ?? 'acme';
  const repo = opts.repo ?? 'widget';
  const slug = opts.slug;
  const branch = opts.branch ?? `loom/${slug}`;

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-dispatch-'));
  const worktreeRel = path.join(
    '.loom',
    'agents',
    agent,
    'worktrees',
    `${org}_${repo}_${slug}`,
  );
  const worktreePath = path.join(parent, worktreeRel);
  await fs.mkdir(worktreePath, { recursive: true });

  await git(worktreePath, ['init', '-q', '-b', 'main']);
  await git(worktreePath, ['config', 'user.email', 'test.bot@loom.local']);
  await git(worktreePath, ['config', 'user.name', 'Loom Test Bot']);
  await git(worktreePath, ['config', 'commit.gpgsign', 'false']);
  await git(worktreePath, ['config', 'tag.gpgsign', 'false']);

  // Initial empty commit so HEAD exists before we branch.
  await gitWithStdin(
    worktreePath,
    ['commit', '-q', '--allow-empty', '-F', '-'],
    'init\n',
  );

  // Check out the target branch (creating if necessary).
  if (branch !== 'main') {
    await git(worktreePath, ['checkout', '-q', '-b', branch]);
  }

  return {
    parent,
    worktreePath,
    async cleanup() {
      await fs.rm(parent, { recursive: true, force: true });
    },
  };
}

interface AssignedTrailerOverrides {
  taskStatus?: string;
  agentId?: string | null;
  sessionId?: string | null;
  assignedTo?: string | null;
  assignment?: string | null;
  scope?: string | null;
  dependencies?: string | null;
  budget?: string | null;
}

/**
 * Write a commit at HEAD with the standard ASSIGNED trailer shape,
 * optionally overriding any field (set to null to omit that trailer).
 *
 * When `files` is provided, the files are written into the worktree
 * and staged before committing. Otherwise the commit is empty.
 */
async function commitAssigned(
  worktreePath: string,
  overrides: AssignedTrailerOverrides = {},
  files: Record<string, string> = {},
): Promise<void> {
  // Write files first.
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(worktreePath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    await git(worktreePath, ['add', '--', rel]);
  }

  const fields: Array<[string, string | null]> = [
    ['Agent-Id', overrides.agentId !== undefined ? overrides.agentId : 'ratchet'],
    [
      'Session-Id',
      overrides.sessionId !== undefined
        ? overrides.sessionId
        : '00000000-0000-0000-0000-000000000001',
    ],
    [
      'Assigned-To',
      overrides.assignedTo !== undefined ? overrides.assignedTo : 'ratchet',
    ],
    [
      'Assignment',
      overrides.assignment !== undefined ? overrides.assignment : 'test-slug',
    ],
    [
      'Scope',
      overrides.scope !== undefined ? overrides.scope : 'src/a.ts src/b.ts',
    ],
    [
      'Dependencies',
      overrides.dependencies !== undefined ? overrides.dependencies : 'none',
    ],
    ['Budget', overrides.budget !== undefined ? overrides.budget : '60000'],
    [
      'Task-Status',
      overrides.taskStatus !== undefined ? overrides.taskStatus : 'ASSIGNED',
    ],
  ];

  const trailerLines = fields
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`);

  const message = `task(tools): test-slug\n\n${trailerLines.join('\n')}\n`;

  const hasFiles = Object.keys(files).length > 0;
  const commitArgs = ['commit', '-q', '-F', '-'];
  if (!hasFiles) commitArgs.push('--allow-empty');

  await gitWithStdin(worktreePath, commitArgs, message);
}

function ruleIds(violations: Array<{ rule: string }>): string[] {
  return violations.map((v) => v.rule);
}

describe('dispatch-check tool', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  async function fresh(opts: {
    slug: string;
    branch?: string;
  }): Promise<LoomWorktree> {
    const wt = await createLoomWorktree(opts);
    cleanups.push(() => wt.cleanup());
    return wt;
  }

  // ---------- Positive ----------

  it('P1: well-formed ASSIGNED worktree with existing scope paths → no violations', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      { scope: 'src/a.ts src/b.ts' },
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.violations).toEqual([]);
    expect(result.data.ok).toBe(true);
  });

  // ---------- Negative (one per rule) ----------

  it('N1: worktree at non-matching path → worktree-path-shape', async () => {
    // Create a plain tmpdir (not matching .loom/agents/... shape) but
    // still init a git repo in it so the remaining rules have something
    // to read.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-plain-'));
    cleanups.push(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });
    await git(tmp, ['init', '-q', '-b', 'main']);
    await git(tmp, ['config', 'user.email', 'test.bot@loom.local']);
    await git(tmp, ['config', 'user.name', 'Loom Test Bot']);
    await git(tmp, ['config', 'commit.gpgsign', 'false']);
    await gitWithStdin(
      tmp,
      ['commit', '-q', '--allow-empty', '-F', '-'],
      'init\n',
    );
    await git(tmp, ['checkout', '-q', '-b', 'loom/test-slug']);
    await commitAssigned(tmp, {}, { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' });

    const result = await dispatchCheckTool.handler(
      { worktree: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(ruleIds(result.data.violations)).toContain('worktree-path-shape');
    expect(result.data.ok).toBe(false);
  });

  it('N2: wrong branch name → branch-name-shape', async () => {
    const wt = await fresh({ slug: 'widget-fix', branch: 'feature/wrong-name' });
    await commitAssigned(
      wt.worktreePath,
      {},
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const rules = ruleIds(result.data.violations);
    expect(rules).toContain('branch-name-shape');
    // And the worktree-path-shape rule should NOT fire here.
    expect(rules).not.toContain('worktree-path-shape');
  });

  it('N3: Task-Status PLANNING at HEAD → assigned-at-head', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      { taskStatus: 'PLANNING' },
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(ruleIds(result.data.violations)).toContain('assigned-at-head');
  });

  it('N4: missing Agent-Id → assigned-trailers-valid surfaces agent-id-required', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      { agentId: null },
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const violations = result.data.violations.filter(
      (v) => v.rule === 'assigned-trailers-valid',
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.detail.includes('agent-id-required'))).toBe(
      true,
    );
  });

  it('N5: sibling AGENT.json exists → no-sibling-agent-json', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      {},
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    // Parent of worktree is .loom/agents/test/worktrees/ — plant an
    // AGENT.json there.
    const sibling = path.join(wt.worktreePath, '..', 'AGENT.json');
    await fs.writeFile(sibling, '{}\n');

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(ruleIds(result.data.violations)).toContain('no-sibling-agent-json');
  });

  it('N6: Scope references a nonexistent path → scope-paths-exist', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      { scope: 'src/a.ts src/nonexistent.ts' },
      { 'src/a.ts': '// a\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const violations = result.data.violations.filter(
      (v) => v.rule === 'scope-paths-exist',
    );
    expect(violations.length).toBe(1);
    expect(violations[0].detail).toContain('src/nonexistent.ts');
  });

  it('N7: wrong branch AND missing scope path → both rules fire (rules are independent)', async () => {
    const wt = await fresh({ slug: 'widget-fix', branch: 'feature/wrong-name' });
    await commitAssigned(
      wt.worktreePath,
      { scope: 'src/a.ts src/missing.ts' },
      { 'src/a.ts': '// a\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const rules = ruleIds(result.data.violations);
    expect(rules).toContain('branch-name-shape');
    expect(rules).toContain('scope-paths-exist');
  });

  // Tripwire: pin the `ctx` surface that rule #4's stub assumes trailer-validate
  // reads. If trailer-validate grows to call ctx.emit, the stub's no-op swallows
  // the event silently. This test wraps the stub's emit with a spy and asserts
  // it is never called during a dispatch-check run that otherwise passes rule #4.
  it('T1: trailer-validate handler does not touch ctx.emit (rule #4 composition tripwire)', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      {},
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    const emitSpy = vi.fn();
    const originalHandler = trailerValidateTool.handler;
    const handlerSpy = vi
      .spyOn(trailerValidateTool, 'handler')
      .mockImplementation(async (input, ctx) => {
        const wrappedCtx: ToolContext = { ...ctx, emit: emitSpy };
        return originalHandler(input, wrappedCtx);
      });

    try {
      const result = await dispatchCheckTool.handler(
        { worktree: wt.worktreePath },
        makeCtx(),
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect(result.data.violations).toEqual([]);

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      const passedCtx = handlerSpy.mock.calls[0][1];
      expect(passedCtx.worktree).toBe(wt.worktreePath);
      expect(passedCtx.role).toBe('orchestrator');
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      handlerSpy.mockRestore();
    }
  });

  // Parser commitment: underscore is the org/repo/slug separator. A repo whose
  // name contains an underscore (e.g. `loom_tools`) cannot be represented — the
  // parser silently takes `loom` as org, `tools` as repo, everything after as
  // slug. This test pins that behaviour; a future parser change that allows
  // underscores in repo names will break it.
  it('T2: underscore-in-repo-name directory misparses — slug = segment after last _', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-underscore-'));
    cleanups.push(async () => {
      await fs.rm(parent, { recursive: true, force: true });
    });
    const worktreePath = path.join(
      parent,
      '.loom',
      'agents',
      'test',
      'worktrees',
      'loom_tools_dispatch-check',
    );
    await fs.mkdir(worktreePath, { recursive: true });
    await git(worktreePath, ['init', '-q', '-b', 'main']);
    await git(worktreePath, ['config', 'user.email', 'test.bot@loom.local']);
    await git(worktreePath, ['config', 'user.name', 'Loom Test Bot']);
    await git(worktreePath, ['config', 'commit.gpgsign', 'false']);
    await gitWithStdin(
      worktreePath,
      ['commit', '-q', '--allow-empty', '-F', '-'],
      'init\n',
    );
    // Branch named as if repo were 'loom_tools' and slug 'dispatch-check'.
    // The parser disagrees (slug = 'dispatch-check'), so expected branch is
    // 'loom/dispatch-check' and the actual 'loom/loom_tools_dispatch-check'
    // fires branch-name-shape. The repo-name collision itself is invisible.
    await git(worktreePath, [
      'checkout',
      '-q',
      '-b',
      'loom/loom_tools_dispatch-check',
    ]);
    await commitAssigned(
      worktreePath,
      {},
      { 'src/a.ts': '// a\n', 'src/b.ts': '// b\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const rules = ruleIds(result.data.violations);
    // Parser matched the path: rule #1 did not fire.
    expect(rules).not.toContain('worktree-path-shape');
    // Rule #2 fires: parser-extracted slug 'dispatch-check' != branch suffix.
    expect(rules).toContain('branch-name-shape');
    const branchV = result.data.violations.find(
      (v) => v.rule === 'branch-name-shape',
    );
    expect(branchV?.detail).toContain("'loom/dispatch-check'");
  });

  // Bare-commit case: HEAD is the repo's initial empty commit (no LOOM
  // trailers). This is what the orchestrator leaves behind when the ASSIGNED
  // commit is forgotten entirely. Rule #3 (assigned-at-head) fires with a
  // "no Task-Status trailer" detail; rule #4 cascades — and we assert both
  // are present and distinct so an operator can read the root cause.
  it('T3: bare-commit worktree (no ASSIGNED commit) → rule #3 and rule #4 both fire distinctly', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    // Intentionally NO commitAssigned — HEAD stays on the initial empty commit.

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const rules = ruleIds(result.data.violations);
    expect(rules).toContain('assigned-at-head');
    expect(rules).toContain('assigned-trailers-valid');

    const rule3 = result.data.violations.filter(
      (v) => v.rule === 'assigned-at-head',
    );
    expect(rule3.length).toBe(1);
    expect(rule3[0].detail).toContain('no Task-Status trailer');

    // Rule #4 surfaces trailer-validate's own errors (Agent-Id, Session-Id, ...)
    // as separate violations — not collapsed into rule #3.
    const rule4 = result.data.violations.filter(
      (v) => v.rule === 'assigned-trailers-valid',
    );
    expect(rule4.length).toBeGreaterThan(0);
    expect(rule4.some((v) => v.detail.includes('agent-id-required'))).toBe(
      true,
    );
  });

  // Path-traversal defence on rule #6. A Scope entry that resolves outside the
  // worktree (e.g. `../../etc/passwd`) used to pass if the resolved file
  // happened to exist. The defence rejects such entries before the existsSync.
  it('T4: Scope with path traversal → scope-paths-exist surfaces outside-worktree violation', async () => {
    const wt = await fresh({ slug: 'widget-fix' });
    await commitAssigned(
      wt.worktreePath,
      { scope: 'src/a.ts ../../../etc/passwd' },
      { 'src/a.ts': '// a\n' },
    );

    const result = await dispatchCheckTool.handler(
      { worktree: wt.worktreePath },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    const scopeViolations = result.data.violations.filter(
      (v) => v.rule === 'scope-paths-exist',
    );
    expect(scopeViolations.length).toBe(1);
    expect(scopeViolations[0].detail).toContain('../../../etc/passwd');
    expect(scopeViolations[0].detail).toContain('outside the worktree');
    expect(result.data.ok).toBe(false);
  });
});
