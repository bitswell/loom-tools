import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../../src/types/context.js';
import { submoduleBumpTool } from '../../src/tools/submodule-bump.js';
import { createFixtureRepo } from '../harness/fixture-repo.js';
import { exec } from '../../src/util/exec.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'bitswell',
    sessionId: 'orch-session',
    role: 'orchestrator',
    branch: 'main',
    worktree: '/tmp/worktree',
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec('git', args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} in ${cwd} failed: ${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}

/**
 * Build an inner/outer pair: two inner commits A, B; outer has inner
 * added as a submodule at commit A. Returns paths and SHAs.
 */
async function makePair(): Promise<{
  inner: { path: string; shaA: string; shaB: string };
  outer: { path: string };
  submodulePath: string;
  cleanup: () => Promise<void>;
}> {
  // Allow file:// protocol for submodules in modern git.
  const innerRepo = await createFixtureRepo();
  const outerRepo = await createFixtureRepo();

  const shaA = await innerRepo.commit({
    subject: 'inner A',
    files: { 'a.txt': 'A' },
  });
  const shaB = await innerRepo.commit({
    subject: 'inner B',
    files: { 'b.txt': 'B' },
  });

  const submodulePath = 'deps/inner';

  // Enable file:// submodule transport.
  await git(outerRepo.path, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    innerRepo.path,
    submodulePath,
  ]);
  await git(outerRepo.path, ['commit', '-m', 'add inner submodule at A']);

  // Outer added B as working-tree HEAD of the submodule (because inner
  // was at B when we added it). Rewind to A so we have a real bump to do.
  await git(path.join(outerRepo.path, submodulePath), ['checkout', shaA]);
  await git(outerRepo.path, ['add', submodulePath]);
  await git(outerRepo.path, ['commit', '-m', 'pin submodule to A']);

  return {
    inner: { path: innerRepo.path, shaA, shaB },
    outer: { path: outerRepo.path },
    submodulePath,
    cleanup: async () => {
      await innerRepo.cleanup();
      await outerRepo.cleanup();
    },
  };
}

describe('submodule-bump tool', () => {
  it('is scoped to orchestrator role only', () => {
    expect(submoduleBumpTool.definition.roles).toEqual(['orchestrator']);
  });

  it('bumps a submodule from A to B and stages the gitlink', async () => {
    const { inner, outer, submodulePath, cleanup } = await makePair();
    try {
      const result = await submoduleBumpTool.handler(
        {
          submodulePath,
          targetSha: inner.shaB,
          parentDir: outer.path,
        },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.submodulePath).toBe(submodulePath);
      expect(result.data.previousSha).toBe(inner.shaA);
      expect(result.data.targetSha).toBe(inner.shaB);
      expect(result.data.staged).toBe(true);

      const diff = await git(outer.path, [
        'diff',
        '--cached',
        '--',
        submodulePath,
      ]);
      expect(diff).toContain(inner.shaA.slice(0, 7));
      expect(diff).toContain(inner.shaB.slice(0, 7));
    } finally {
      await cleanup();
    }
  });

  it('N1: returns not-a-submodule when path is not tracked', async () => {
    const outer = await createFixtureRepo();
    try {
      await outer.commit({
        subject: 'real file',
        files: { 'README.md': 'hi' },
      });

      const result = await submoduleBumpTool.handler(
        {
          submodulePath: 'nothing/here',
          targetSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          parentDir: outer.path,
        },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe('not-a-submodule');
    } finally {
      await outer.cleanup();
    }
  });

  it('N2: returns fetch-failed when targetSha does not exist in remote', async () => {
    const { outer, submodulePath, cleanup } = await makePair();
    try {
      const result = await submoduleBumpTool.handler(
        {
          submodulePath,
          targetSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          parentDir: outer.path,
        },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe('fetch-failed');
    } finally {
      await cleanup();
    }
  });

  it('N3: returns not-a-repo when parentDir is not a git repo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const result = await submoduleBumpTool.handler(
        {
          submodulePath: 'anything',
          targetSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          parentDir: tmp,
        },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe('not-a-repo');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('remoteUrl override takes precedence over .gitmodules', async () => {
    const { inner, outer, submodulePath, cleanup } = await makePair();
    try {
      // Break the .gitmodules URL so only the override can work.
      await git(outer.path, [
        'config',
        '--file',
        '.gitmodules',
        `submodule.${submodulePath}.url`,
        '/does/not/exist',
      ]);

      const result = await submoduleBumpTool.handler(
        {
          submodulePath,
          targetSha: inner.shaB,
          remoteUrl: inner.path,
          parentDir: outer.path,
        },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.targetSha).toBe(inner.shaB);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-hex targetSha at the boundary', async () => {
    const result = await submoduleBumpTool.handler(
      {
        submodulePath: 'deps/inner',
        targetSha: 'not-a-sha!',
        parentDir: '/tmp',
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-input');
  });

  it('rejects newline in submodulePath at the boundary', async () => {
    const result = await submoduleBumpTool.handler(
      {
        submodulePath: 'deps/inner\nfoo',
        targetSha: 'deadbeef',
        parentDir: '/tmp',
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-input');
  });

  // --- F6: staged flag is honest on no-op bump ---
  it('F6: reports staged=false when bumping to the same SHA', async () => {
    const { inner, outer, submodulePath, cleanup } = await makePair();
    try {
      const first = await submoduleBumpTool.handler(
        { submodulePath, targetSha: inner.shaB, parentDir: outer.path },
        makeCtx(),
      );
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.data.staged).toBe(true);
      await git(outer.path, ['commit', '-m', 'bump to B']);

      const second = await submoduleBumpTool.handler(
        { submodulePath, targetSha: inner.shaB, parentDir: outer.path },
        makeCtx(),
      );
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.data.previousSha).toBe(inner.shaB);
      expect(second.data.targetSha).toBe(inner.shaB);
      expect(second.data.staged).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // --- F7: too-short SHA rejected at the boundary ---
  it('F7: rejects a 1-char hex "sha"', async () => {
    const result = await submoduleBumpTool.handler(
      {
        submodulePath: 'deps/inner',
        targetSha: 'a',
        parentDir: '/tmp',
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-input');
  });

  it('F7: rejects a 6-char hex "sha" (below minimum)', async () => {
    const result = await submoduleBumpTool.handler(
      {
        submodulePath: 'deps/inner',
        targetSha: 'abcdef',
        parentDir: '/tmp',
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-input');
  });

  // --- F8: newline in parentDir rejected at the boundary ---
  it('F8: rejects newline in parentDir', async () => {
    const result = await submoduleBumpTool.handler(
      {
        submodulePath: 'deps/inner',
        targetSha: 'deadbeef',
        parentDir: '/tmp\nhack',
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-input');
  });
});
