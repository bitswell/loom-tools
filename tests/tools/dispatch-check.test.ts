import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchCheckTool } from '../../src/tools/dispatch-check.js';
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
});
