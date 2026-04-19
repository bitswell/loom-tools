import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../../src/types/context.js';
import { toolRequestTool } from '../../src/tools/tool-request.js';
import { createFixtureRepo } from '../harness/fixture-repo.js';
import { exec } from '../../src/util/exec.js';

// No vi.mock here: this file exercises tool-request against real git to
// prove the caller's HEAD/index/worktree are byte-identical before and
// after a request.

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec('git', args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} in ${cwd} exit ${r.exitCode}: ${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}

describe('tool-request (fixture)', () => {
  it('leaves caller state byte-identical and commits to refs/heads/tool-requests', async () => {
    const repo = await createFixtureRepo();
    const origin = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-origin-'));

    try {
      // Dirty the caller: committed file plus an unstaged edit.
      await repo.commit({
        subject: 'caller work',
        files: { 'work.txt': 'original' },
      });
      await fs.writeFile(path.join(repo.path, 'work.txt'), 'dirty edit');

      const headBefore = await git(repo.path, ['rev-parse', 'HEAD']);
      const statusBefore = await git(repo.path, ['status', '--porcelain=v1']);
      const diffBefore = await git(repo.path, ['diff']);
      const branchBefore = await git(repo.path, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);

      // Local bare remote so push is an on-disk op with no network.
      await exec('git', ['init', '--bare', '-q', origin], process.cwd()).then(
        (r) => {
          if (r.exitCode !== 0) throw new Error(r.stderr);
        },
      );
      await git(repo.path, ['remote', 'add', 'origin', origin]);

      const ctx: ToolContext = {
        agentId: 'moss',
        sessionId: 'fixture-session',
        role: 'writer',
        branch: branchBefore,
        worktree: repo.path,
        scope: [],
        scopeDenied: [],
        emit: vi.fn(),
      };

      const result = await toolRequestTool.handler(
        { toolName: 'integration-deploy', reason: 'fixture check' },
        ctx,
      );

      expect(result.success).toBe(true);
      const commitSha = result.success ? result.data.commitSha : '';
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Caller state byte-identical.
      expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await git(repo.path, ['status', '--porcelain=v1'])).toBe(
        statusBefore,
      );
      expect(await git(repo.path, ['diff'])).toBe(diffBefore);
      expect(
        await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).toBe(branchBefore);

      // Request commit landed on refs/heads/tool-requests, locally and on origin.
      expect(
        await git(repo.path, ['rev-parse', 'refs/heads/tool-requests']),
      ).toBe(commitSha);
      expect(
        await git(origin, ['rev-parse', 'refs/heads/tool-requests']),
      ).toBe(commitSha);

      // Orphan: no parent on first request.
      const firstParents = await git(repo.path, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        commitSha,
      ]);
      expect(firstParents.trim().split(/\s+/).length).toBe(1);

      // Trailers intact.
      const trailers = await git(repo.path, [
        'log',
        '-1',
        '--format=%(trailers:only,unfold)',
        commitSha,
      ]);
      expect(trailers).toContain('Agent-Id: moss');
      expect(trailers).toContain('Session-Id: fixture-session');
      expect(trailers).toContain('Tool-Requested: integration-deploy');

      // Second request chains onto the first (parented, not orphan).
      const second = await toolRequestTool.handler(
        { toolName: 'another-tool', reason: 'second' },
        ctx,
      );
      expect(second.success).toBe(true);
      const secondSha = second.success ? second.data.commitSha : '';
      const secondParents = await git(repo.path, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        secondSha,
      ]);
      const parts = secondParents.trim().split(/\s+/);
      expect(parts.length).toBe(2);
      expect(parts[1]).toBe(commitSha);

      // Caller state still unchanged after the second call.
      expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await git(repo.path, ['status', '--porcelain=v1'])).toBe(
        statusBefore,
      );
    } finally {
      await repo.cleanup();
      await fs.rm(origin, { recursive: true, force: true });
    }
  });

  it('recovers a stranded commit on the next successful push', async () => {
    const repo = await createFixtureRepo();
    const origin = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-origin-'));
    const unreachable = path.join(os.tmpdir(), 'tr-nonexistent-' + Date.now());

    try {
      await exec('git', ['init', '--bare', '-q', origin], process.cwd()).then(
        (r) => {
          if (r.exitCode !== 0) throw new Error(r.stderr);
        },
      );

      await git(repo.path, ['remote', 'add', 'origin', origin]);

      const ctx: ToolContext = {
        agentId: 'moss',
        sessionId: 'fixture-session',
        role: 'writer',
        branch: 'main',
        worktree: repo.path,
        scope: [],
        scopeDenied: [],
        emit: vi.fn(),
      };

      // First call: ref created locally and on origin.
      const first = await toolRequestTool.handler(
        { toolName: 'first-tool', reason: 'initial' },
        ctx,
      );
      expect(first.success).toBe(true);
      const firstSha = first.success ? first.data.commitSha : '';
      expect(first.success && first.data.pushed).toBe(true);

      // Break the remote: both ls-remote and push will fail. Because a
      // local tip exists from step 1, syncWithOrigin falls through to
      // "serve with local tip" — the stranded path.
      await git(repo.path, ['remote', 'set-url', 'origin', unreachable]);

      const second = await toolRequestTool.handler(
        { toolName: 'second-tool', reason: 'offline' },
        ctx,
      );
      expect(second.success).toBe(true);
      const secondSha = second.success ? second.data.commitSha : '';
      expect(second.success && second.data.pushed).toBe(false);

      // Local ref advanced even though push failed.
      expect(
        await git(repo.path, ['rev-parse', 'refs/heads/tool-requests']),
      ).toBe(secondSha);

      // Origin still shows only the first commit.
      expect(
        await git(origin, ['rev-parse', 'refs/heads/tool-requests']),
      ).toBe(firstSha);

      // Restore origin. The third call's push carries both the stranded
      // second commit and the fresh third commit onto origin.
      await git(repo.path, ['remote', 'set-url', 'origin', origin]);

      const third = await toolRequestTool.handler(
        { toolName: 'third-tool', reason: 'back online' },
        ctx,
      );
      expect(third.success).toBe(true);
      const thirdSha = third.success ? third.data.commitSha : '';
      expect(third.success && third.data.pushed).toBe(true);

      // Origin now holds all three in order first → second → third.
      expect(
        await git(origin, ['rev-parse', 'refs/heads/tool-requests']),
      ).toBe(thirdSha);
      const originHistory = (
        await git(origin, [
          'rev-list',
          'refs/heads/tool-requests',
        ])
      )
        .split('\n')
        .filter((l) => l.length > 0);
      expect(originHistory).toEqual([thirdSha, secondSha, firstSha]);
    } finally {
      await repo.cleanup();
      await fs.rm(origin, { recursive: true, force: true });
    }
  });

  it('refuses when caller is checked out to tool-requests', async () => {
    const repo = await createFixtureRepo();
    try {
      // Create the branch and check it out.
      await git(repo.path, ['checkout', '-b', 'tool-requests']);

      const headBefore = await git(repo.path, ['rev-parse', 'HEAD']);
      const branchBefore = await git(repo.path, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      expect(branchBefore).toBe('tool-requests');

      const ctx: ToolContext = {
        agentId: 'moss',
        sessionId: 'fixture-session',
        role: 'writer',
        branch: 'tool-requests',
        worktree: repo.path,
        scope: [],
        scopeDenied: [],
        emit: vi.fn(),
      };

      const result = await toolRequestTool.handler(
        { toolName: 'x', reason: 'y' },
        ctx,
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('caller-on-tool-requests');
      }

      // HEAD untouched.
      expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(
        await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).toBe('tool-requests');

      // No commit made.
      const count = await git(repo.path, [
        'rev-list',
        '--count',
        'HEAD',
      ]);
      expect(count).toBe('1'); // just the init commit from the fixture
    } finally {
      await repo.cleanup();
    }
  });
});
