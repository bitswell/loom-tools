import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repoCreateTool } from '../../src/tools/repo-create.js';

vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

describe('repo-create tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a repo, initializes, and applies protection', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view (not exists)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // gh repo create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git clone
      // README is now written via writeFileSync — no exec call
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // gh api rulesets
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // rm -rf (cleanup)

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'test-repo' },
      {} as any,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://github.com/bitswell/test-repo');
      expect(result.data.sshUrl).toBe('git@github.com:bitswell/test-repo.git');
      expect(result.data.protected).toBe(true);
    }
  });

  it('skips creation when repo already exists (idempotent)', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '{"name":"existing"}', stderr: '', exitCode: 0 })  // gh repo view (exists)
      // No gh repo create call
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // gh api rulesets
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // rm -rf

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'existing' },
      {} as any,
    );

    expect(result.success).toBe(true);
    // Second call should be git clone, not gh repo create
    expect(mockExec.mock.calls[1][0]).toBe('git');
    expect(mockExec.mock.calls[1][1]).toContain('clone');
  });

  it('returns error when repo creation fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: 'forbidden', exitCode: 1 }); // gh repo create fails

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'noperm' },
      {} as any,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('repo-create-failed');
    }
  });

  it('returns error when clone fails and cleans up', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create ok
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: not found', exitCode: 128 }) // clone fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // rm -rf (finally cleanup)

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'test' },
      {} as any,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('clone-failed');
    }
    // Verify cleanup was called (last exec call is rm -rf)
    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1];
    expect(lastCall[0]).toBe('rm');
    expect(lastCall[1][0]).toBe('-rf');
  });

  it('cleans up on push failure', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: 'rejected', exitCode: 1 }) // push fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // rm -rf (finally)

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'no-push' },
      {} as any,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('push-failed');
    }
    // Verify cleanup still happened
    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1];
    expect(lastCall[0]).toBe('rm');
  });

  it('succeeds even when protection fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // push
      .mockResolvedValueOnce({ stdout: '', stderr: 'forbidden', exitCode: 1 }) // protection fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // cleanup

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'no-protect' },
      {} as any,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.protected).toBe(false);
    }
  });

  it('passes visibility flag', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // protect
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // cleanup

    await repoCreateTool.handler(
      { org: 'bitswell', name: 'pub-repo', visibility: 'public' },
      {} as any,
    );

    // Second call is gh repo create (after gh repo view)
    expect(mockExec.mock.calls[1][1]).toContain('--public');
  });

  it('passes description when provided', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // protect
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // cleanup

    await repoCreateTool.handler(
      { org: 'bitswell', name: 'desc-repo', description: 'A test repo' },
      {} as any,
    );

    expect(mockExec.mock.calls[1][1]).toContain('--description');
    expect(mockExec.mock.calls[1][1]).toContain('A test repo');
  });

  it('uses writeFileSync for README instead of shell command', async () => {
    const { writeFileSync } = await import('node:fs');
    const mockWriteFileSync = vi.mocked(writeFileSync);

    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 1 })  // gh repo view
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // protect
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // cleanup

    await repoCreateTool.handler(
      { org: 'bitswell', name: 'safe-repo' },
      {} as any,
    );

    // Verify writeFileSync was called for README (first call; second is ruleset)
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('README.md'),
      '# safe-repo\n',
    );

    // Verify no bash -c calls exist
    for (const call of mockExec.mock.calls) {
      expect(call[0]).not.toBe('bash');
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(repoCreateTool.definition.roles).toEqual(['orchestrator']);
  });

  it('schema rejects missing org', () => {
    const parsed = repoCreateTool.definition.inputSchema.safeParse({ name: 'foo' });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects invalid visibility', () => {
    const parsed = repoCreateTool.definition.inputSchema.safeParse({
      org: 'bitswell',
      name: 'foo',
      visibility: 'internal',
    });
    expect(parsed.success).toBe(false);
  });
});
