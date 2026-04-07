import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/types/context.js';
import { ciGenerateTool, generateCiFiles } from '../../src/tools/ci-generate.js';

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

describe('generateCiFiles (standalone function)', () => {
  it('returns empty files map for empty features', () => {
    const files = generateCiFiles('rust', []);
    expect(Object.keys(files)).toHaveLength(0);
  });

  // --- Rust ---

  it('generates cargo test for rust test feature', () => {
    const files = generateCiFiles('rust', ['test']);
    expect(files['.github/workflows/ci.yml']).toContain('cargo test');
  });

  it('generates cargo check for rust typecheck feature', () => {
    const files = generateCiFiles('rust', ['typecheck']);
    expect(files['.github/workflows/ci.yml']).toContain('cargo check');
  });

  it('generates cargo clippy for rust lint feature', () => {
    const files = generateCiFiles('rust', ['lint']);
    expect(files['.github/workflows/ci.yml']).toContain('cargo clippy');
  });

  it('uses rust-toolchain setup for rust', () => {
    const files = generateCiFiles('rust', ['test']);
    expect(files['.github/workflows/ci.yml']).toContain(
      'dtolnay/rust-toolchain@stable',
    );
  });

  // --- TypeScript ---

  it('generates npx vitest run for typescript test feature', () => {
    const files = generateCiFiles('typescript', ['test']);
    expect(files['.github/workflows/ci.yml']).toContain('npx vitest run');
  });

  it('generates npx tsc --noEmit for typescript typecheck feature', () => {
    const files = generateCiFiles('typescript', ['typecheck']);
    expect(files['.github/workflows/ci.yml']).toContain('npx tsc --noEmit');
  });

  it('generates npx eslint for typescript lint feature', () => {
    const files = generateCiFiles('typescript', ['lint']);
    expect(files['.github/workflows/ci.yml']).toContain('npx eslint .');
  });

  it('uses setup-node for typescript', () => {
    const files = generateCiFiles('typescript', ['test']);
    expect(files['.github/workflows/ci.yml']).toContain(
      'actions/setup-node@v4',
    );
    expect(files['.github/workflows/ci.yml']).toContain('npm ci');
  });

  // --- Go ---

  it('generates go test for go test feature', () => {
    const files = generateCiFiles('go', ['test']);
    expect(files['.github/workflows/ci.yml']).toContain('go test ./...');
  });

  it('generates go build for go typecheck feature', () => {
    const files = generateCiFiles('go', ['typecheck']);
    expect(files['.github/workflows/ci.yml']).toContain('go build ./...');
  });

  it('generates golangci-lint for go lint feature', () => {
    const files = generateCiFiles('go', ['lint']);
    expect(files['.github/workflows/ci.yml']).toContain('golangci-lint run');
  });

  it('uses setup-go for go', () => {
    const files = generateCiFiles('go', ['test']);
    expect(files['.github/workflows/ci.yml']).toContain('actions/setup-go@v5');
  });

  // --- File paths ---

  it('all output file paths start with .github/workflows/', () => {
    const files = generateCiFiles('typescript', [
      'test',
      'typecheck',
      'lint',
      'gh-pages',
      'release',
    ]);
    for (const path of Object.keys(files)) {
      expect(path).toMatch(/^\.github\/workflows\//);
    }
  });

  // --- Combined features ---

  it('puts test, typecheck, lint into a single ci.yml', () => {
    const files = generateCiFiles('rust', ['test', 'typecheck', 'lint']);
    expect(Object.keys(files)).toContain('.github/workflows/ci.yml');
    const ci = files['.github/workflows/ci.yml'];
    expect(ci).toContain('cargo test');
    expect(ci).toContain('cargo check');
    expect(ci).toContain('cargo clippy');
  });

  // --- Separate workflow files ---

  it('generates gh-pages as a separate workflow file', () => {
    const files = generateCiFiles('typescript', ['gh-pages']);
    expect(Object.keys(files)).toContain('.github/workflows/gh-pages.yml');
    expect(Object.keys(files)).not.toContain('.github/workflows/ci.yml');
    expect(files['.github/workflows/gh-pages.yml']).toContain('GitHub Pages');
    expect(files['.github/workflows/gh-pages.yml']).toContain(
      'deploy-pages@v4',
    );
  });

  it('generates release as a separate workflow file', () => {
    const files = generateCiFiles('rust', ['release']);
    expect(Object.keys(files)).toContain('.github/workflows/release.yml');
    expect(Object.keys(files)).not.toContain('.github/workflows/ci.yml');
    expect(files['.github/workflows/release.yml']).toContain('Release');
    expect(files['.github/workflows/release.yml']).toContain(
      'cargo build --release',
    );
  });

  it('generates both ci.yml and separate files when mixed', () => {
    const files = generateCiFiles('go', ['test', 'gh-pages', 'release']);
    expect(Object.keys(files)).toHaveLength(3);
    expect(Object.keys(files)).toContain('.github/workflows/ci.yml');
    expect(Object.keys(files)).toContain('.github/workflows/gh-pages.yml');
    expect(Object.keys(files)).toContain('.github/workflows/release.yml');
  });

  // --- YAML structure ---

  it('ci.yml has proper workflow structure', () => {
    const files = generateCiFiles('typescript', ['test']);
    const ci = files['.github/workflows/ci.yml'];
    expect(ci).toContain('name: CI');
    expect(ci).toContain('on:');
    expect(ci).toContain('push:');
    expect(ci).toContain('branches: [main]');
    expect(ci).toContain('pull_request:');
    expect(ci).toContain('jobs:');
  });
});

describe('ciGenerateTool', () => {
  it('is scoped to orchestrator role only', () => {
    expect(ciGenerateTool.definition.roles).toEqual(['orchestrator']);
  });

  it('has correct tool name', () => {
    expect(ciGenerateTool.definition.name).toBe('ci-generate');
  });

  it('handler returns success with files', async () => {
    const result = await ciGenerateTool.handler(
      { language: 'rust', features: ['test', 'lint'] },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files).toBeDefined();
      expect(result.data.files['.github/workflows/ci.yml']).toBeDefined();
    }
  });
});
