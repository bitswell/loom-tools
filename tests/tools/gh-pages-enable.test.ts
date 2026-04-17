import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { ghPagesEnableTool } from '../../src/tools/gh-pages-enable.js';

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

describe('gh-pages-enable tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables GitHub Pages and returns URL from API response', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify({ html_url: 'https://bitswell.github.io/loom-site/' }),
      stderr: '',
      exitCode: 0,
    });

    const result = await ghPagesEnableTool.handler(
      { repo: 'bitswell/loom-site' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://bitswell.github.io/loom-site/');
      expect(result.data.enabled).toBe(true);
    }
  });

  it('passes correct API args to gh', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 });

    await ghPagesEnableTool.handler(
      { repo: 'bitswell/loom-site' },
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        'repos/bitswell/loom-site/pages',
        '-X', 'POST',
        '-f', 'build_type=workflow',
        '-f', 'source[branch]=main',
        '-f', 'source[path]=/',
      ],
      '/tmp/worktree',
    );
  });

  it('returns constructed URL when API response has no html_url', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '{"status": "built"}',
      stderr: '',
      exitCode: 0,
    });

    const result = await ghPagesEnableTool.handler(
      { repo: 'bitswell/loom-site' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://bitswell.github.io/loom-site/');
    }
  });

  it('returns constructed URL when stdout is not valid JSON', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: 'not json',
      stderr: '',
      exitCode: 0,
    });

    const result = await ghPagesEnableTool.handler(
      { repo: 'org/repo' },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://org.github.io/repo/');
    }
  });

  it('returns error when API call fails', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Not Found',
      exitCode: 1,
    });

    const result = await ghPagesEnableTool.handler(
      { repo: 'bitswell/nonexistent' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('gh-pages-enable-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('is scoped to orchestrator role only', () => {
    expect(ghPagesEnableTool.definition.roles).toEqual(['orchestrator']);
  });

  it('schema rejects empty input', () => {
    const parsed = ghPagesEnableTool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
