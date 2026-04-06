import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { compileTool, detectLanguage } from '../../src/tools/compile.js';

// Mock exec
vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

// Mock fs.existsSync for language detection
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
import { existsSync } from 'node:fs';

const mockExec = vi.mocked(exec);
const mockExists = vi.mocked(existsSync);

function makeCtx(): ToolContext {
  return {
    agentId: 'ratchet',
    sessionId: 'test-session',
    role: 'writer',
    branch: 'loom/test',
    worktree: '/tmp/project',
    scope: ['src/'],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

describe('detectLanguage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects rust from Cargo.toml', () => {
    mockExists.mockImplementation((p) =>
      String(p).endsWith('Cargo.toml'),
    );
    expect(detectLanguage('/tmp/project')).toBe('rust');
  });

  it('detects typescript from package.json', () => {
    mockExists.mockImplementation((p) =>
      String(p).endsWith('package.json'),
    );
    expect(detectLanguage('/tmp/project')).toBe('typescript');
  });

  it('detects go from go.mod', () => {
    mockExists.mockImplementation((p) =>
      String(p).endsWith('go.mod'),
    );
    expect(detectLanguage('/tmp/project')).toBe('go');
  });

  it('returns null when no project file found', () => {
    mockExists.mockReturnValue(false);
    expect(detectLanguage('/tmp/empty')).toBeNull();
  });

  it('prefers rust over typescript when both exist', () => {
    mockExists.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('Cargo.toml') || s.endsWith('package.json');
    });
    expect(detectLanguage('/tmp/project')).toBe('rust');
  });
});

describe('compile tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when language not detected and not overridden', async () => {
    mockExists.mockReturnValue(false);
    const result = await compileTool.handler({}, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('language-not-detected');
    }
  });

  it('runs cargo check for rust', async () => {
    mockExists.mockImplementation((p) =>
      String(p).endsWith('Cargo.toml'),
    );
    mockExec.mockResolvedValueOnce({
      stdout: 'Compiling...',
      stderr: '',
      exitCode: 0,
    });

    const result = await compileTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.language).toBe('rust');
      expect(result.data.success).toBe(true);
    }
    expect(mockExec).toHaveBeenCalledWith('cargo', ['check'], '/tmp/project');
  });

  it('runs npx tsc --noEmit for typescript', async () => {
    mockExists.mockImplementation((p) =>
      String(p).endsWith('package.json'),
    );
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const result = await compileTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.language).toBe('typescript');
    }
    expect(mockExec).toHaveBeenCalledWith(
      'npx',
      ['tsc', '--noEmit'],
      '/tmp/project',
    );
  });

  it('uses language override instead of detection', async () => {
    mockExists.mockReturnValue(false);
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const result = await compileTool.handler({ language: 'go' }, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.language).toBe('go');
    }
    expect(mockExec).toHaveBeenCalledWith(
      'go',
      ['build', './...'],
      '/tmp/project',
    );
  });

  it('reports compilation failure with success: false in data', async () => {
    mockExists.mockImplementation((p) =>
      String(p).endsWith('package.json'),
    );
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'error TS2304: Cannot find name',
      exitCode: 2,
    });

    const result = await compileTool.handler({}, makeCtx());
    expect(result.success).toBe(true); // The tool succeeded, compilation failed
    if (result.success) {
      expect(result.data.success).toBe(false);
      expect(result.data.stderr).toContain('TS2304');
    }
  });
});
