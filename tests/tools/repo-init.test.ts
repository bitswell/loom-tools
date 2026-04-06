import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { repoInitTool } from '../../src/tools/repo-init.js';

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

describe('repo-init tool', () => {
  it('is scoped to orchestrator role only', () => {
    expect(repoInitTool.definition.roles).toEqual(['orchestrator']);
  });

  it('has correct tool name', () => {
    expect(repoInitTool.definition.name).toBe('repo-init');
  });

  // --- CI feature ---

  it('ci feature includes workflow files', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'my-org/my-repo', language: 'typescript', features: ['ci'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files['.github/workflows/ci.yml']).toBeDefined();
      // Should include test, typecheck, lint jobs
      const ci = result.data.files['.github/workflows/ci.yml'];
      expect(ci).toContain('npx vitest run');
      expect(ci).toContain('npx tsc --noEmit');
      expect(ci).toContain('npx eslint .');
    }
  });

  it('ci feature for rust includes cargo commands', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'my-org/my-repo', language: 'rust', features: ['ci'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const ci = result.data.files['.github/workflows/ci.yml'];
      expect(ci).toContain('cargo test');
      expect(ci).toContain('cargo check');
      expect(ci).toContain('cargo clippy');
    }
  });

  // --- License feature ---

  it('license feature produces MIT text with year and org', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'acme-corp', language: 'go', features: ['license'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const license = result.data.files['LICENSE'];
      expect(license).toBeDefined();
      expect(license).toContain('MIT License');
      expect(license).toContain('acme-corp');
      expect(license).toContain(String(new Date().getFullYear()));
      expect(license).toContain('Permission is hereby granted');
    }
  });

  // --- Gitignore feature ---

  it('gitignore feature produces rust-appropriate content', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'my-repo', language: 'rust', features: ['gitignore'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const gi = result.data.files['.gitignore'];
      expect(gi).toBeDefined();
      expect(gi).toContain('/target/');
      expect(gi).toContain('Cargo.lock');
    }
  });

  it('gitignore feature produces typescript-appropriate content', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'my-repo', language: 'typescript', features: ['gitignore'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const gi = result.data.files['.gitignore'];
      expect(gi).toContain('node_modules/');
      expect(gi).toContain('dist/');
    }
  });

  it('gitignore feature produces go-appropriate content', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'my-repo', language: 'go', features: ['gitignore'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const gi = result.data.files['.gitignore'];
      expect(gi).toContain('/bin/');
    }
  });

  // --- Branch protection feature ---

  it('branch-protection feature produces a script with gh api calls', async () => {
    const result = await repoInitTool.handler(
      {
        repoName: 'my-org/my-repo',
        language: 'typescript',
        features: ['branch-protection'],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const script = result.data.files['scripts/branch-protection.sh'];
      expect(script).toBeDefined();
      expect(script).toContain('gh api');
      expect(script).toContain('my-org/my-repo');
      expect(script).toContain('required_pull_request_reviews');
      expect(script).toContain('allow_force_pushes=false');
      expect(script).toContain('allow_deletions=false');
      expect(script).toContain('#!/usr/bin/env bash');
    }
  });

  // --- Composition ---

  it('all features together produces complete scaffold', async () => {
    const result = await repoInitTool.handler(
      {
        repoName: 'acme/widget',
        language: 'go',
        features: ['ci', 'branch-protection', 'license', 'gitignore'],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const paths = Object.keys(result.data.files);
      expect(paths).toContain('.github/workflows/ci.yml');
      expect(paths).toContain('LICENSE');
      expect(paths).toContain('.gitignore');
      expect(paths).toContain('scripts/branch-protection.sh');
    }
  });

  it('empty features produces no files', async () => {
    const result = await repoInitTool.handler(
      { repoName: 'my-repo', language: 'rust', features: [] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.files)).toHaveLength(0);
    }
  });
});
