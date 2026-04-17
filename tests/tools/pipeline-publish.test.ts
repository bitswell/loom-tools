import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { pipelinePublishTool } from '../../src/tools/pipeline-publish.js';

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

const baseInput = {
  issueSha: 'abc123',
  retro: {
    title: 'retro: completed task',
    body: 'Findings and observations.',
    agentId: 'ratchet',
    sessionId: 'sess-42',
  },
  note: { status: 'done', outcome: 'merged' },
};

describe('pipeline-publish tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes retro and pipeline note successfully', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'retro-sha\n', stderr: '', exitCode: 0 }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // notes add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push notes
      .mockResolvedValueOnce({ stdout: 'sha\trefs/heads/retros\n', stderr: '', exitCode: 0 }) // ls-remote retros
      .mockResolvedValueOnce({ stdout: 'sha\trefs/notes/pipeline\n', stderr: '', exitCode: 0 }) // ls-remote notes
      .mockResolvedValueOnce({ stdout: 'note-sha\n', stderr: '', exitCode: 0 })  // rev-parse notes ref
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // worktree remove (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.retroSha).toBe('retro-sha');
      expect(result.data.noteSha).toBe('note-sha');
      expect(result.data.verified).toBe(true);
    }
  });

  it('creates orphan branch when retros branch does not exist', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: invalid ref', exitCode: 128 }) // worktree add fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree add --detach
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // checkout --orphan
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // git rm cached
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'retro-sha\n', stderr: '', exitCode: 0 }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // notes add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push notes
      .mockResolvedValueOnce({ stdout: 'sha\tretros\n', stderr: '', exitCode: 0 }) // ls-remote retros
      .mockResolvedValueOnce({ stdout: 'sha\trefs/notes/pipeline\n', stderr: '', exitCode: 0 }) // ls-remote notes
      .mockResolvedValueOnce({ stdout: 'note-sha\n', stderr: '', exitCode: 0 }) // rev-parse notes
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(true);
  });

  it('returns error when retro commit fails and cleans up', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree add
      .mockResolvedValueOnce({ stdout: '', stderr: 'nothing to commit', exitCode: 1 }) // commit fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('retro-commit-failed');
    }
  });

  it('returns error when push retros fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: 'rejected', exitCode: 1 }) // push fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('push-retros-failed');
    }
  });

  it('returns error when note add fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: 'error: cannot note', exitCode: 1 }) // note fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('note-add-failed');
    }
  });

  it('returns error when note ref cannot be resolved', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // notes add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push notes
      .mockResolvedValueOnce({ stdout: 'sha\tretros\n', stderr: '', exitCode: 0 }) // ls-remote retros
      .mockResolvedValueOnce({ stdout: 'sha\tnotes\n', stderr: '', exitCode: 0 }) // ls-remote notes
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })   // rev-parse notes fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('note-ref-resolve-failed');
    }
  });

  it('returns error when verification fails', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // notes add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push notes
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // ls-remote retros (empty = no match)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // ls-remote notes (empty)
      .mockResolvedValueOnce({ stdout: 'note-sha\n', stderr: '', exitCode: 0 }) // rev-parse notes ok
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup (finally)

    const result = await pipelinePublishTool.handler(baseInput, makeCtx());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('verification-failed');
    }
  });

  it('uses custom remote when provided', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // notes add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push notes
      .mockResolvedValueOnce({ stdout: 'sha\tretros\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\tnotes\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });  // cleanup

    await pipelinePublishTool.handler(
      { ...baseInput, remote: 'upstream' },
      makeCtx(),
    );

    // Push retros should use 'upstream'
    const pushRetrosCall = mockExec.mock.calls[3];
    expect(pushRetrosCall[1]).toContain('upstream');

    // Push notes should use 'upstream'
    const pushNotesCall = mockExec.mock.calls[5];
    expect(pushNotesCall[1]).toContain('upstream');
  });

  it('formats note content as YAML key-value pairs', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push retros
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // notes add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // push notes
      .mockResolvedValueOnce({ stdout: 'sha\tretros\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\tnotes\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await pipelinePublishTool.handler(baseInput, makeCtx());

    // notes add call is call index 4
    const noteAddCall = mockExec.mock.calls[4];
    expect(noteAddCall[0]).toBe('git');
    expect(noteAddCall[1]).toContain('--ref=pipeline');
    // Check the -m arg contains formatted YAML
    const msgIdx = (noteAddCall[1] as string[]).indexOf('-m');
    const noteMsg = (noteAddCall[1] as string[])[msgIdx + 1];
    expect(noteMsg).toContain('status: done');
    expect(noteMsg).toContain('outcome: merged');
  });

  it('uses tmpdir for worktree path, not cwd', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // worktree add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // commit
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\tretros\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\tnotes\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await pipelinePublishTool.handler(baseInput, makeCtx());

    // worktree add path should be in tmpdir, not agent's worktree
    const worktreeAddCall = mockExec.mock.calls[0];
    const worktreePathArg = (worktreeAddCall[1] as string[])[2]; // 'git worktree add <path> retros'
    expect(worktreePathArg).not.toContain('/tmp/worktree/.loom');
    expect(worktreePathArg).toMatch(/loom-retros-/);
  });

  it('is scoped to orchestrator role only', () => {
    expect(pipelinePublishTool.definition.roles).toEqual(['orchestrator']);
  });

  it('noteSha output description mentions ref tip', () => {
    const noteShaProp = pipelinePublishTool.definition.outputSchema.shape.noteSha;
    expect(noteShaProp.description).toContain('ref tip');
  });

  it('schema rejects missing issueSha', () => {
    const parsed = pipelinePublishTool.definition.inputSchema.safeParse({
      retro: baseInput.retro,
      note: baseInput.note,
    });
    expect(parsed.success).toBe(false);
  });
});
