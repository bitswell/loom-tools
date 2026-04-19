import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../../src/types/context.js';
import { projectApplyTool } from '../../src/tools/project-apply.js';

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

describe('project-apply tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-apply-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // --- P1 ---
  it('is scoped to orchestrator role only', () => {
    expect(projectApplyTool.definition.roles).toEqual(['orchestrator']);
  });

  // --- P2: minimal input ---
  it('writes a single flat file and reports it in applied', async () => {
    const result = await projectApplyTool.handler(
      { files: { 'a.txt': 'hello' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.applied).toEqual(['a.txt']);
    expect(result.data.skipped).toEqual([]);
    expect(result.data.baseDir).toBe(await fs.realpath(tmp));

    const content = await fs.readFile(path.join(tmp, 'a.txt'), 'utf8');
    expect(content).toBe('hello');
  });

  // --- P3: nested path creates parents ---
  it('creates parent directories for nested paths', async () => {
    const result = await projectApplyTool.handler(
      { files: { 'src/deep/file.ts': 'x' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.applied).toEqual(['src/deep/file.ts']);
    const content = await fs.readFile(
      path.join(tmp, 'src', 'deep', 'file.ts'),
      'utf8',
    );
    expect(content).toBe('x');
  });

  // --- P4: dry-run writes nothing ---
  it('dry-run lists every path as skipped and writes nothing', async () => {
    const result = await projectApplyTool.handler(
      {
        files: { 'a.txt': 'A', 'b/c.txt': 'B' },
        baseDir: tmp,
        dryRun: true,
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.applied).toEqual([]);
    expect(result.data.skipped).toEqual([
      { path: 'a.txt', reason: 'dry-run' },
      { path: 'b/c.txt', reason: 'dry-run' },
    ]);

    const entries = await fs.readdir(tmp);
    expect(entries).toEqual([]);
  });

  // --- P5: overwrite default refused ---
  it('refuses to overwrite existing files without force', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'original');

    const result = await projectApplyTool.handler(
      { files: { 'a.txt': 'new' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.applied).toEqual([]);
    expect(result.data.skipped).toEqual([
      { path: 'a.txt', reason: 'exists' },
    ]);

    const content = await fs.readFile(path.join(tmp, 'a.txt'), 'utf8');
    expect(content).toBe('original');
  });

  // --- P6: force overwrite ---
  it('overwrites existing files when force is true', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'original');

    const result = await projectApplyTool.handler(
      { files: { 'a.txt': 'new' }, baseDir: tmp, force: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.applied).toEqual(['a.txt']);
    expect(result.data.skipped).toEqual([]);

    const content = await fs.readFile(path.join(tmp, 'a.txt'), 'utf8');
    expect(content).toBe('new');
  });

  // --- P7: mixed state partitioning ---
  it('partitions correctly when some files exist and some do not', async () => {
    await fs.writeFile(path.join(tmp, 'exists.txt'), 'kept');

    const result = await projectApplyTool.handler(
      {
        files: {
          'exists.txt': 'should-not-apply',
          'new.txt': 'new-content',
          'nested/x.txt': 'nested-content',
        },
        baseDir: tmp,
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.applied).toEqual(['new.txt', 'nested/x.txt']);
    expect(result.data.skipped).toEqual([
      { path: 'exists.txt', reason: 'exists' },
    ]);

    expect(await fs.readFile(path.join(tmp, 'exists.txt'), 'utf8')).toBe(
      'kept',
    );
    expect(await fs.readFile(path.join(tmp, 'new.txt'), 'utf8')).toBe(
      'new-content',
    );
    expect(
      await fs.readFile(path.join(tmp, 'nested', 'x.txt'), 'utf8'),
    ).toBe('nested-content');
  });

  // --- N1: absolute path ---
  it('N1: rejects absolute paths', async () => {
    const result = await projectApplyTool.handler(
      { files: { '/etc/passwd': 'evil' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-path');
  });

  // --- N2: parent segment ---
  it('N2: rejects .. segments', async () => {
    const result = await projectApplyTool.handler(
      { files: { 'a/../b': 'x' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-path');
  });

  // --- N3: empty key ---
  it('N3: rejects empty keys', async () => {
    const result = await projectApplyTool.handler(
      { files: { '': 'x' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-path');
  });

  // --- baseDir default ---
  it('resolves baseDir to an absolute path', async () => {
    const result = await projectApplyTool.handler(
      { files: { 'a.txt': 'hi' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(path.isAbsolute(result.data.baseDir)).toBe(true);
  });

  // --- F1: symlink-based escape ---
  it('F1: refuses writes through a symlink that escapes baseDir', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'project-apply-out-'));
    try {
      await fs.symlink(outside, path.join(tmp, 'escape'));

      const result = await projectApplyTool.handler(
        { files: { 'escape/gotcha.txt': 'pwned' }, baseDir: tmp },
        makeCtx(),
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe('path-escape');

      const entries = await fs.readdir(outside);
      expect(entries).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  // --- F1: intra-baseDir symlinks (not escaping) are permitted ---
  it('F1: allows writes through a symlink that stays inside baseDir', async () => {
    await fs.mkdir(path.join(tmp, 'real'));
    await fs.symlink(path.join(tmp, 'real'), path.join(tmp, 'via-link'));

    const result = await projectApplyTool.handler(
      { files: { 'via-link/x.txt': 'ok' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.applied).toEqual(['via-link/x.txt']);

    const content = await fs.readFile(path.join(tmp, 'real', 'x.txt'), 'utf8');
    expect(content).toBe('ok');
  });

  // --- F2: FS errors return structured err instead of crashing ---
  it('F2: force-over-directory returns write-failed, not a crash', async () => {
    await fs.mkdir(path.join(tmp, 'collide'));

    const result = await projectApplyTool.handler(
      { files: { collide: 'x' }, baseDir: tmp, force: true },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('write-failed');
    expect(result.error.retryable).toBe(false);
  });

  // --- F2: null byte in filename is rejected, not crashed on ---
  it('F2: rejects NUL in filename as invalid-path', async () => {
    const result = await projectApplyTool.handler(
      { files: { 'bad\u0000name.txt': 'x' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-path');
  });

  // --- F4: leading './' is normalized in reports ---
  it('F4: normalizes leading "./" in applied/skipped', async () => {
    const result = await projectApplyTool.handler(
      { files: { './sub/x.txt': 'hi' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.applied).toEqual(['sub/x.txt']);

    const content = await fs.readFile(path.join(tmp, 'sub', 'x.txt'), 'utf8');
    expect(content).toBe('hi');
  });

  // --- F4: "." resolves to baseDir itself and is rejected ---
  it('F4: rejects "." (baseDir itself)', async () => {
    const result = await projectApplyTool.handler(
      { files: { '.': 'x' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('invalid-path');
  });

  // --- Test gap: stable ordering for numeric-ish keys ---
  it('preserves insertion order for applied/skipped across numeric keys', async () => {
    const result = await projectApplyTool.handler(
      { files: { '1': 'one', '2': 'two', '3': 'three' }, baseDir: tmp },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.applied).toEqual(['1', '2', '3']);
  });
});
