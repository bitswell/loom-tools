import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repoCreateTool } from '../../src/tools/repo-create.js';

vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

describe('repo-create tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a repo, initializes, and applies protection', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // gh repo create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // bash echo README
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // git push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // gh api rulesets
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // rm -rf

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

  it('returns error when repo creation fails', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'already exists',
      exitCode: 1,
    });

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'existing' },
      {} as any,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('repo-create-failed');
    }
  });

  it('returns error when clone fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create ok
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: not found', exitCode: 128 }); // clone fails

    const result = await repoCreateTool.handler(
      { org: 'bitswell', name: 'test' },
      {} as any,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('clone-failed');
    }
  });

  it('succeeds even when protection fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // readme
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
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // readme
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // protect
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // cleanup

    await repoCreateTool.handler(
      { org: 'bitswell', name: 'pub-repo', visibility: 'public' },
      {} as any,
    );

    // First call is gh repo create
    expect(mockExec.mock.calls[0][1]).toContain('--public');
  });

  it('passes description when provided', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // create
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // clone
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // readme
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })  // push
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 }) // protect
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // cleanup

    await repoCreateTool.handler(
      { org: 'bitswell', name: 'desc-repo', description: 'A test repo' },
      {} as any,
    );

    expect(mockExec.mock.calls[0][1]).toContain('--description');
    expect(mockExec.mock.calls[0][1]).toContain('A test repo');
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
