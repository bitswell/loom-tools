import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../../src/tools/index.js';

describe('tool input/output schemas', () => {
  const registry = createDefaultRegistry();

  // --- Phase 2 tools ---

  it('commit schema accepts valid input', () => {
    const tool = registry.get('commit')!;
    const parsed = tool.definition.inputSchema.safeParse({
      message: 'fix: something',
    });
    expect(parsed.success).toBe(true);
  });

  it('commit schema accepts input with files and trailers', () => {
    const tool = registry.get('commit')!;
    const parsed = tool.definition.inputSchema.safeParse({
      message: 'fix: something',
      files: ['src/foo.ts'],
      trailers: { 'Task-Status': 'IMPLEMENTING' },
    });
    expect(parsed.success).toBe(true);
  });

  it('commit schema rejects missing message', () => {
    const tool = registry.get('commit')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('push schema accepts empty input', () => {
    const tool = registry.get('push')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('push schema accepts remote and force', () => {
    const tool = registry.get('push')!;
    const parsed = tool.definition.inputSchema.safeParse({
      remote: 'upstream',
      force: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('read-assignment schema accepts empty input', () => {
    const tool = registry.get('read-assignment')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('compile schema accepts empty input', () => {
    const tool = registry.get('compile')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('compile schema accepts language override', () => {
    const tool = registry.get('compile')!;
    const parsed = tool.definition.inputSchema.safeParse({
      language: 'rust',
    });
    expect(parsed.success).toBe(true);
  });

  it('compile schema rejects unknown language', () => {
    const tool = registry.get('compile')!;
    const parsed = tool.definition.inputSchema.safeParse({
      language: 'cobol',
    });
    expect(parsed.success).toBe(false);
  });

  it('test schema accepts empty input', () => {
    const tool = registry.get('test')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('test schema accepts filter', () => {
    const tool = registry.get('test')!;
    const parsed = tool.definition.inputSchema.safeParse({
      filter: 'my-test',
    });
    expect(parsed.success).toBe(true);
  });

  it('status-query schema accepts empty input', () => {
    const tool = registry.get('status-query')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('status-query schema accepts pattern', () => {
    const tool = registry.get('status-query')!;
    const parsed = tool.definition.inputSchema.safeParse({
      pattern: 'loom/ratchet-*',
    });
    expect(parsed.success).toBe(true);
  });

  // --- Phase 3 tools ---

  // assign
  it('assign schema accepts valid input', () => {
    const tool = registry.get('assign')!;
    const parsed = tool.definition.inputSchema.safeParse({
      agentId: 'ratchet',
      branch: 'loom/ratchet-task',
      taskBody: 'Do the thing',
    });
    expect(parsed.success).toBe(true);
  });

  it('assign schema accepts all optional fields', () => {
    const tool = registry.get('assign')!;
    const parsed = tool.definition.inputSchema.safeParse({
      agentId: 'ratchet',
      branch: 'loom/ratchet-task',
      taskBody: 'Do the thing',
      scope: 'src/',
      dependencies: 'bitswell/phase-2',
      budget: 50000,
    });
    expect(parsed.success).toBe(true);
  });

  it('assign schema rejects missing required fields', () => {
    const tool = registry.get('assign')!;
    expect(tool.definition.inputSchema.safeParse({}).success).toBe(false);
    expect(
      tool.definition.inputSchema.safeParse({ agentId: 'r' }).success,
    ).toBe(false);
  });

  // dispatch
  it('dispatch schema accepts valid input', () => {
    const tool = registry.get('dispatch')!;
    const parsed = tool.definition.inputSchema.safeParse({
      agentId: 'ratchet',
      worktreePath: '/tmp/wt',
      phase: 'implementation',
    });
    expect(parsed.success).toBe(true);
  });

  it('dispatch schema accepts optional branch', () => {
    const tool = registry.get('dispatch')!;
    const parsed = tool.definition.inputSchema.safeParse({
      agentId: 'ratchet',
      worktreePath: '/tmp/wt',
      phase: 'planning',
      branch: 'loom/custom',
    });
    expect(parsed.success).toBe(true);
  });

  it('dispatch schema rejects invalid phase', () => {
    const tool = registry.get('dispatch')!;
    const parsed = tool.definition.inputSchema.safeParse({
      agentId: 'ratchet',
      worktreePath: '/tmp/wt',
      phase: 'testing',
    });
    expect(parsed.success).toBe(false);
  });

  // wait
  it('wait schema accepts branch only', () => {
    const tool = registry.get('wait')!;
    const parsed = tool.definition.inputSchema.safeParse({
      branch: 'loom/ratchet',
    });
    expect(parsed.success).toBe(true);
  });

  it('wait schema accepts all fields', () => {
    const tool = registry.get('wait')!;
    const parsed = tool.definition.inputSchema.safeParse({
      branch: 'loom/ratchet',
      pollIntervalMs: 1000,
      timeoutMs: 60000,
    });
    expect(parsed.success).toBe(true);
  });

  it('wait schema rejects missing branch', () => {
    const tool = registry.get('wait')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  // status
  it('status schema accepts empty input', () => {
    const tool = registry.get('status')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('status schema accepts pattern', () => {
    const tool = registry.get('status')!;
    const parsed = tool.definition.inputSchema.safeParse({
      pattern: 'loom/ratchet-*',
    });
    expect(parsed.success).toBe(true);
  });

  // pr-create
  it('pr-create schema accepts valid input', () => {
    const tool = registry.get('pr-create')!;
    const parsed = tool.definition.inputSchema.safeParse({
      head: 'feature',
      base: 'main',
      title: 'My PR',
    });
    expect(parsed.success).toBe(true);
  });

  it('pr-create schema accepts optional body', () => {
    const tool = registry.get('pr-create')!;
    const parsed = tool.definition.inputSchema.safeParse({
      head: 'feature',
      base: 'main',
      title: 'My PR',
      body: 'Description',
    });
    expect(parsed.success).toBe(true);
  });

  it('pr-create schema rejects missing required fields', () => {
    const tool = registry.get('pr-create')!;
    expect(
      tool.definition.inputSchema.safeParse({ head: 'x' }).success,
    ).toBe(false);
  });

  // pr-retarget
  it('pr-retarget schema accepts valid input', () => {
    const tool = registry.get('pr-retarget')!;
    const parsed = tool.definition.inputSchema.safeParse({
      number: 42,
      base: 'develop',
    });
    expect(parsed.success).toBe(true);
  });

  it('pr-retarget schema rejects missing number', () => {
    const tool = registry.get('pr-retarget')!;
    const parsed = tool.definition.inputSchema.safeParse({
      base: 'main',
    });
    expect(parsed.success).toBe(false);
  });

  // pr-merge
  it('pr-merge schema accepts number only', () => {
    const tool = registry.get('pr-merge')!;
    const parsed = tool.definition.inputSchema.safeParse({ number: 42 });
    expect(parsed.success).toBe(true);
  });

  it('pr-merge schema accepts method', () => {
    const tool = registry.get('pr-merge')!;
    const parsed = tool.definition.inputSchema.safeParse({
      number: 42,
      method: 'squash',
    });
    expect(parsed.success).toBe(true);
  });

  it('pr-merge schema rejects invalid method', () => {
    const tool = registry.get('pr-merge')!;
    const parsed = tool.definition.inputSchema.safeParse({
      number: 42,
      method: 'fast-forward',
    });
    expect(parsed.success).toBe(false);
  });

  // review-request
  it('review-request schema accepts valid input', () => {
    const tool = registry.get('review-request')!;
    const parsed = tool.definition.inputSchema.safeParse({
      number: 42,
      reviewers: ['drift', 'sable'],
    });
    expect(parsed.success).toBe(true);
  });

  it('review-request schema rejects empty reviewers', () => {
    const tool = registry.get('review-request')!;
    const parsed = tool.definition.inputSchema.safeParse({
      number: 42,
      reviewers: [],
    });
    expect(parsed.success).toBe(false);
  });

  // submodule
  it('submodule schema accepts valid input', () => {
    const tool = registry.get('submodule')!;
    const parsed = tool.definition.inputSchema.safeParse({
      path: 'repos/loom-tools',
      ref: 'v1.0.0',
    });
    expect(parsed.success).toBe(true);
  });

  it('submodule schema rejects missing ref', () => {
    const tool = registry.get('submodule')!;
    const parsed = tool.definition.inputSchema.safeParse({
      path: 'repos/loom-tools',
    });
    expect(parsed.success).toBe(false);
  });

  // tool-request
  it('tool-request schema accepts minimal input', () => {
    const tool = registry.get('tool-request')!;
    const parsed = tool.definition.inputSchema.safeParse({
      toolName: 'deploy',
      reason: 'Need to deploy',
    });
    expect(parsed.success).toBe(true);
  });

  it('tool-request schema accepts all fields', () => {
    const tool = registry.get('tool-request')!;
    const parsed = tool.definition.inputSchema.safeParse({
      toolName: 'deploy',
      reason: 'Need to deploy',
      blocking: true,
      pollIntervalMs: 1000,
      timeoutMs: 30000,
    });
    expect(parsed.success).toBe(true);
  });

  it('tool-request schema rejects missing toolName', () => {
    const tool = registry.get('tool-request')!;
    const parsed = tool.definition.inputSchema.safeParse({
      reason: 'Need it',
    });
    expect(parsed.success).toBe(false);
  });
});
