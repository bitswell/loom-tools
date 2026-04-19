import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { pipelineNoteSetTool } from '../../src/tools/pipeline-note-set.js';
import type { ToolContext } from '../../src/types/context.js';
import { exec } from '../../src/util/exec.js';

function makeCtx(worktree: string): ToolContext {
  return {
    agentId: 'test',
    sessionId: 'test-session',
    role: 'writer',
    branch: 'main',
    worktree,
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await exec('git', args, cwd);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
}

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
      reject(new Error('git child has no stdin'));
      return;
    }
    child.stdin.end(input);
  });
}

interface Fixture {
  repo: string;
  sha: string;
  cleanup: () => Promise<void>;
}

async function makeRepo(): Promise<Fixture> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-pns-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test.bot@loom.local']);
  await git(repo, ['config', 'user.name', 'Loom Test Bot']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await gitWithStdin(
    repo,
    ['commit', '-q', '--allow-empty', '-F', '-'],
    'initial\n',
  );
  const r = await exec('git', ['rev-parse', 'HEAD'], repo);
  if (r.exitCode !== 0) throw new Error('rev-parse failed');
  return {
    repo,
    sha: r.stdout.trim(),
    async cleanup() {
      await fs.rm(repo, { recursive: true, force: true });
    },
  };
}

async function seedNote(repo: string, sha: string, body: string): Promise<void> {
  await git(repo, ['notes', '--ref=pipeline', 'add', '-f', '-m', body, sha]);
}

async function readNote(repo: string, sha: string): Promise<string> {
  const r = await exec('git', ['notes', '--ref=pipeline', 'show', sha], repo);
  if (r.exitCode !== 0) throw new Error(`no note: ${r.stderr.trim()}`);
  return r.stdout.replace(/\n$/, '');
}

describe('pipeline-note-set tool', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  async function fresh(): Promise<Fixture> {
    const f = await makeRepo();
    cleanups.push(() => f.cleanup());
    return f;
  }

  it('a) no existing note — writes exactly the new lines', async () => {
    const f = await fresh();
    const result = await pipelineNoteSetTool.handler(
      {
        sha: f.sha,
        pairs: [
          { key: 'status', value: 'filed' },
          { key: 'issue-pr', value: '123' },
        ],
      },
      makeCtx(f.repo),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.previous).toBeNull();
    expect(result.data.current).toBe('status: filed\nissue-pr: 123');
    expect(await readNote(f.repo, f.sha)).toBe('status: filed\nissue-pr: 123');
  });

  it('b) existing note + no key overlap — existing preserved, new appended', async () => {
    const f = await fresh();
    await seedNote(f.repo, f.sha, 'status: filed\nissue-pr: 123');

    const result = await pipelineNoteSetTool.handler(
      {
        sha: f.sha,
        pairs: [{ key: 'reviewer', value: 'moss' }],
      },
      makeCtx(f.repo),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.previous).toBe('status: filed\nissue-pr: 123');
    expect(result.data.current).toBe(
      'status: filed\nissue-pr: 123\nreviewer: moss',
    );
    expect(await readNote(f.repo, f.sha)).toBe(
      'status: filed\nissue-pr: 123\nreviewer: moss',
    );
  });

  it('c) selective replacement — only overlapping keys are dropped', async () => {
    const f = await fresh();
    await seedNote(
      f.repo,
      f.sha,
      'status: filed\nissue-pr: 123\nreviewer: moss',
    );

    const result = await pipelineNoteSetTool.handler(
      {
        sha: f.sha,
        pairs: [
          { key: 'status', value: 'planned' },
          { key: 'implementer', value: 'ratchet' },
        ],
      },
      makeCtx(f.repo),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.current).toBe(
      'issue-pr: 123\nreviewer: moss\nstatus: planned\nimplementer: ratchet',
    );
    expect(await readNote(f.repo, f.sha)).toBe(
      'issue-pr: 123\nreviewer: moss\nstatus: planned\nimplementer: ratchet',
    );
  });

  it('d) values with spaces and punctuation round-trip exactly', async () => {
    const f = await fresh();
    const value = 'https://github.com/bitswell/bitswell/pull/42 — assigned: moss';
    const result = await pipelineNoteSetTool.handler(
      {
        sha: f.sha,
        pairs: [{ key: 'retro-link', value }],
      },
      makeCtx(f.repo),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.current).toBe(`retro-link: ${value}`);
    expect(await readNote(f.repo, f.sha)).toBe(`retro-link: ${value}`);
  });

  it('e) malformed input — schema rejects empty sha, empty pairs, empty key', async () => {
    const schema = pipelineNoteSetTool.definition.inputSchema;

    expect(
      schema.safeParse({
        sha: '',
        pairs: [{ key: 'status', value: 'filed' }],
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        sha: 'abc123',
        pairs: [],
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        sha: 'abc123',
        pairs: [{ key: '', value: 'filed' }],
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        sha: 'abc123',
        pairs: [{ key: 'status', value: 'filed' }],
      }).success,
    ).toBe(true);
  });

  it('duplicate keys in input — last entry wins', async () => {
    const f = await fresh();
    const result = await pipelineNoteSetTool.handler(
      {
        sha: f.sha,
        pairs: [
          { key: 'status', value: 'filed' },
          { key: 'status', value: 'planned' },
        ],
      },
      makeCtx(f.repo),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.current).toBe('status: planned');
    expect(await readNote(f.repo, f.sha)).toBe('status: planned');
  });

});
