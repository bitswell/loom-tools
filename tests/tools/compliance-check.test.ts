import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import {
  complianceCheckTool,
  parseOwnerRepo,
} from '../../src/tools/compliance-check.js';

vi.mock('../../src/util/exec.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../src/util/exec.js';
const mockExec = vi.mocked(exec);

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

// Full protection response with everything enabled
const FULL_PROTECTION = JSON.stringify({
  required_pull_request_reviews: {
    required_approving_review_count: 2,
  },
  required_status_checks: {
    strict: true,
    contexts: ['ci'],
  },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_signatures: { enabled: true },
});

// Minimal protection: enabled but missing most rules
const MINIMAL_PROTECTION = JSON.stringify({
  allow_force_pushes: { enabled: true },
  allow_deletions: { enabled: true },
});

describe('parseOwnerRepo', () => {
  it('parses SSH remote URL', () => {
    expect(parseOwnerRepo('git@github.com:acme/widget.git')).toBe(
      'acme/widget',
    );
  });

  it('parses SSH remote URL without .git suffix', () => {
    expect(parseOwnerRepo('git@github.com:acme/widget')).toBe('acme/widget');
  });

  it('parses HTTPS remote URL', () => {
    expect(parseOwnerRepo('https://github.com/acme/widget.git')).toBe(
      'acme/widget',
    );
  });

  it('parses HTTPS remote URL without .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/acme/widget')).toBe(
      'acme/widget',
    );
  });

  it('parses HTTP remote URL', () => {
    expect(parseOwnerRepo('http://github.com/acme/widget.git')).toBe(
      'acme/widget',
    );
  });

  it('returns null for unrecognized format', () => {
    expect(parseOwnerRepo('/local/path/to/repo')).toBeNull();
  });

  it('handles trailing whitespace', () => {
    expect(parseOwnerRepo('git@github.com:acme/widget.git\n')).toBe(
      'acme/widget',
    );
  });
});

describe('compliance-check tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is scoped to orchestrator role only', () => {
    expect(complianceCheckTool.definition.roles).toEqual(['orchestrator']);
  });

  it('has correct tool name', () => {
    expect(complianceCheckTool.definition.name).toBe('compliance-check');
  });

  it('returns error when remote not found', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: No such remote',
      exitCode: 2,
    });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('remote-not-found');
    }
  });

  it('returns error when remote URL cannot be parsed', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '/local/path',
      stderr: '',
      exitCode: 0,
    });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('parse-failed');
    }
  });

  it('returns error when repo API call fails', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'Not Found',
        exitCode: 1,
      });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('api-failed');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('reports fail when branch protection is not enabled', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'Not Found',
        exitCode: 1,
      });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overall).toBe('fail');
      expect(result.data.rules).toHaveLength(1);
      expect(result.data.rules[0].rule).toBe('branch-protection-enabled');
      expect(result.data.rules[0].status).toBe('fail');
    }
  });

  it('all-passing scenario with full protection', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'https://github.com/acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: FULL_PROTECTION,
        stderr: '',
        exitCode: 0,
      });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overall).toBe('pass');
      // All 6 rules should be checked
      expect(result.data.rules).toHaveLength(6);

      const statuses = result.data.rules.map((r) => r.status);
      expect(statuses.every((s) => s === 'pass')).toBe(true);

      const ruleNames = result.data.rules.map((r) => r.rule);
      expect(ruleNames).toContain('branch-protection-enabled');
      expect(ruleNames).toContain('require-pr-reviews');
      expect(ruleNames).toContain('require-status-checks');
      expect(ruleNames).toContain('no-force-push');
      expect(ruleNames).toContain('no-deletions');
      expect(ruleNames).toContain('signed-commits');
    }
  });

  it('mixed pass/fail scenario with minimal protection', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: MINIMAL_PROTECTION,
        stderr: '',
        exitCode: 0,
      });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overall).toBe('fail');

      const byRule = Object.fromEntries(
        result.data.rules.map((r) => [r.rule, r.status]),
      );
      expect(byRule['branch-protection-enabled']).toBe('pass');
      expect(byRule['require-pr-reviews']).toBe('fail');
      expect(byRule['require-status-checks']).toBe('fail');
      expect(byRule['no-force-push']).toBe('fail');
      expect(byRule['no-deletions']).toBe('fail');
      expect(byRule['signed-commits']).toBe('warn');
    }
  });

  it('uses custom remote when specified', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: FULL_PROTECTION,
        stderr: '',
        exitCode: 0,
      });

    await complianceCheckTool.handler(
      { remote: 'upstream' },
      makeCtx(),
    );

    expect(mockExec.mock.calls[0]).toEqual([
      'git',
      ['remote', 'get-url', 'upstream'],
      '/tmp/worktree',
    ]);
  });

  it('queries correct API endpoints', async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'develop',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: FULL_PROTECTION,
        stderr: '',
        exitCode: 0,
      });

    await complianceCheckTool.handler({}, makeCtx());

    // Repo info call
    expect(mockExec.mock.calls[1]).toEqual([
      'gh',
      ['api', 'repos/acme/widget', '--jq', '.default_branch'],
      '/tmp/worktree',
    ]);

    // Protection call — uses the detected default branch
    expect(mockExec.mock.calls[2]).toEqual([
      'gh',
      ['api', 'repos/acme/widget/branches/develop/protection'],
      '/tmp/worktree',
    ]);
  });

  it('signed-commits is warn level not fail when missing', async () => {
    // Protection with everything passing except signatures
    const protectionNoSig = JSON.stringify({
      required_pull_request_reviews: {
        required_approving_review_count: 1,
      },
      required_status_checks: { strict: true, contexts: [] },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    });

    mockExec
      .mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widget.git',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: protectionNoSig,
        stderr: '',
        exitCode: 0,
      });

    const result = await complianceCheckTool.handler({}, makeCtx());
    expect(result.success).toBe(true);
    if (result.success) {
      // Overall should still be pass — warn doesn't cause fail
      expect(result.data.overall).toBe('pass');

      const signedRule = result.data.rules.find(
        (r) => r.rule === 'signed-commits',
      );
      expect(signedRule?.status).toBe('warn');
    }
  });
});
