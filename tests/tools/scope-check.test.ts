import { describe, it, expect, afterEach, vi } from 'vitest';
import { scopeCheckTool } from '../../src/tools/scope-check.js';
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
 * Build a LOOM branch on top of main with the supplied commits.
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
  allowedPaths: string[],
  deniedPaths: string[] = [],
  base: string = 'main',
) {
  const result = await scopeCheckTool.handler(
    { branch, base, allowedPaths, deniedPaths },
    makeCtx(repo.path),
  );
  if (!result.success) {
    throw new Error(`scope-check failed: ${result.error.message}`);
  }
  return result.data;
}

describe('scope-check tool', () => {
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

  it('P1: all files within scope -> ok', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p1', [
      {
        subject: 'add src file',
        trailers: trailers(),
        files: { 'src/tools/foo.ts': 'export {};\n' },
      },
      {
        subject: 'add another src file',
        trailers: trailers(),
        files: { 'src/tools/bar.ts': 'export {};\n' },
      },
    ]);

    const data = await runCheck(repo, 'loom/p1', ['src/']);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
    expect(data.expansions).toEqual([]);
    expect(data.checkedFiles).toContain('src/tools/foo.ts');
    expect(data.checkedFiles).toContain('src/tools/bar.ts');
  });

  it('P2: file outside scope covered by Scope-Expand -> ok, in expansions', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p2', [
      {
        subject: 'add in-scope file',
        trailers: trailers(),
        files: { 'src/tools/foo.ts': 'export {};\n' },
      },
      {
        subject: 'add out-of-scope file with expand',
        trailers: trailers({
          'Scope-Expand': 'tests/tools/foo.test.ts -- needed for test coverage',
        }),
        files: { 'tests/tools/foo.test.ts': 'test();\n' },
      },
    ]);

    const data = await runCheck(repo, 'loom/p2', ['src/']);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
    expect(data.expansions).toHaveLength(1);
    expect(data.expansions[0].file).toBe('tests/tools/foo.test.ts');
    expect(data.expansions[0].reason).toBe('needed for test coverage');
  });

  it('P3: empty diff -> ok, no checked files', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p3', [
      {
        subject: 'empty commit',
        trailers: trailers(),
        allowEmpty: true,
      },
    ]);

    const data = await runCheck(repo, 'loom/p3', ['src/']);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
    expect(data.expansions).toEqual([]);
    expect(data.checkedFiles).toEqual([]);
  });

  it('P4: glob allowed patterns work', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/p4', [
      {
        subject: 'add files',
        trailers: trailers(),
        files: {
          'src/tools/scope-check.ts': 'export {};\n',
          'src/util/scope.ts': 'export {};\n',
        },
      },
    ]);

    const data = await runCheck(repo, 'loom/p4', ['src/**']);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
  });

  // ---------- Negative cases ----------

  it('N1: file outside scope, no Scope-Expand -> scope-violation', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n1', [
      {
        subject: 'add out-of-scope file',
        trailers: trailers(),
        files: { 'docs/readme.md': '# hi\n' },
      },
    ]);

    const data = await runCheck(repo, 'loom/n1', ['src/']);
    expect(data.ok).toBe(false);
    expect(data.violations).toHaveLength(1);
    expect(data.violations[0].file).toBe('docs/readme.md');
    expect(data.violations[0].rule).toBe('scope-violation');
    // commit should be a real SHA (40 hex chars)
    expect(data.violations[0].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('N2: file matches denied path -> scope-denied', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n2', [
      {
        subject: 'add denied file',
        trailers: trailers(),
        files: {
          'src/tools/foo.ts': 'export {};\n',
          'src/secret/creds.ts': 'export {};\n',
        },
      },
    ]);

    const data = await runCheck(repo, 'loom/n2', ['src/'], ['src/secret/']);
    expect(data.ok).toBe(false);
    const denied = data.violations.filter((v) => v.rule === 'scope-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].file).toBe('src/secret/creds.ts');
  });

  it('N3: file matches denied path WITH Scope-Expand -> still scope-denied', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n3', [
      {
        subject: 'add denied file with expand',
        trailers: trailers({
          'Scope-Expand': 'src/secret/creds.ts -- really needed it',
        }),
        files: {
          'src/tools/foo.ts': 'export {};\n',
          'src/secret/creds.ts': 'export {};\n',
        },
      },
    ]);

    const data = await runCheck(repo, 'loom/n3', ['src/'], ['src/secret/']);
    expect(data.ok).toBe(false);
    const denied = data.violations.filter((v) => v.rule === 'scope-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].file).toBe('src/secret/creds.ts');
    // Must NOT appear in expansions
    expect(data.expansions.map((e) => e.file)).not.toContain(
      'src/secret/creds.ts',
    );
  });

  it('N4: multiple violations on same branch', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n4', [
      {
        subject: 'add multiple out-of-scope files',
        trailers: trailers(),
        files: {
          'src/tools/good.ts': 'export {};\n',
          'docs/readme.md': '# hi\n',
          'scripts/deploy.sh': '#!/bin/bash\n',
          'config/app.json': '{}\n',
        },
      },
    ]);

    const data = await runCheck(repo, 'loom/n4', ['src/']);
    expect(data.ok).toBe(false);
    expect(data.violations.length).toBeGreaterThanOrEqual(3);
    const violationFiles = data.violations.map((v) => v.file).sort();
    expect(violationFiles).toContain('docs/readme.md');
    expect(violationFiles).toContain('scripts/deploy.sh');
    expect(violationFiles).toContain('config/app.json');
    // All should be scope-violation (not denied)
    for (const v of data.violations) {
      expect(v.rule).toBe('scope-violation');
    }
  });

  it('N5: no allowed paths (empty array) -> all files are violations', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/n5', [
      {
        subject: 'add files with no allowed scope',
        trailers: trailers(),
        files: {
          'src/tools/foo.ts': 'export {};\n',
          'tests/foo.test.ts': 'test();\n',
        },
      },
    ]);

    const data = await runCheck(repo, 'loom/n5', []);
    expect(data.ok).toBe(false);
    expect(data.violations).toHaveLength(2);
    const files = data.violations.map((v) => v.file).sort();
    expect(files).toEqual(['src/tools/foo.ts', 'tests/foo.test.ts']);
  });

  // ---------- Edge cases ----------

  it('E1: invalid base ref returns error result', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/e1', [
      {
        subject: 'add file',
        trailers: trailers(),
        files: { 'src/foo.ts': 'export {};\n' },
      },
    ]);

    const result = await scopeCheckTool.handler(
      {
        branch: 'loom/e1',
        base: 'nonexistent-ref',
        allowedPaths: ['src/'],
        deniedPaths: [],
      },
      makeCtx(repo.path),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('diff-failed');
    }
  });

  it('E2: mixed violations and expansions on same branch', async () => {
    const repo = await fresh();
    await buildBranch(repo, 'loom/e2', [
      {
        subject: 'add files',
        trailers: trailers({
          'Scope-Expand': 'tests/foo.test.ts -- test file needed',
        }),
        files: {
          'src/tools/good.ts': 'export {};\n',
          'tests/foo.test.ts': 'test();\n',
          'docs/readme.md': '# hi\n',
        },
      },
    ]);

    const data = await runCheck(repo, 'loom/e2', ['src/']);
    expect(data.ok).toBe(false);
    // docs/readme.md is a violation
    expect(data.violations).toHaveLength(1);
    expect(data.violations[0].file).toBe('docs/readme.md');
    expect(data.violations[0].rule).toBe('scope-violation');
    // tests/foo.test.ts is an expansion
    expect(data.expansions).toHaveLength(1);
    expect(data.expansions[0].file).toBe('tests/foo.test.ts');
  });
});
