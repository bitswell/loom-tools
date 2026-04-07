import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../../src/tools/index.js';

describe('createDefaultRegistry', () => {
  it('registers all 16 built-in tools', () => {
    const registry = createDefaultRegistry();
    expect(registry.size).toBe(16);
  });

  // Phase 2 tools
  it('registers commit tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('commit')).toBeDefined();
  });

  it('registers push tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('push')).toBeDefined();
  });

  it('registers read-assignment tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('read-assignment')).toBeDefined();
  });

  it('registers compile tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('compile')).toBeDefined();
  });

  it('registers test tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('test')).toBeDefined();
  });

  it('registers status-query tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('status-query')).toBeDefined();
  });

  // Phase 3 — lifecycle tools
  it('registers assign tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('assign')).toBeDefined();
  });

  it('registers dispatch tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('dispatch')).toBeDefined();
  });

  it('registers wait tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('wait')).toBeDefined();
  });

  it('registers status tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('status')).toBeDefined();
  });

  // Phase 3 — workflow tools
  it('registers pr-create tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('pr-create')).toBeDefined();
  });

  it('registers pr-retarget tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('pr-retarget')).toBeDefined();
  });

  it('registers pr-merge tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('pr-merge')).toBeDefined();
  });

  it('registers review-request tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('review-request')).toBeDefined();
  });

  it('registers submodule tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('submodule')).toBeDefined();
  });

  // Phase 3 — self-service
  it('registers tool-request tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('tool-request')).toBeDefined();
  });

  // Role scoping
  it('writer can access commit, push, compile, test, read-assignment, status-query, tool-request', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('writer');
    expect(names).toContain('commit');
    expect(names).toContain('push');
    expect(names).toContain('compile');
    expect(names).toContain('test');
    expect(names).toContain('read-assignment');
    expect(names).toContain('status-query');
    expect(names).toContain('tool-request');
    expect(names).toHaveLength(7);
  });

  it('writer cannot access orchestrator-only tools', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('writer');
    expect(names).not.toContain('assign');
    expect(names).not.toContain('dispatch');
    expect(names).not.toContain('wait');
    expect(names).not.toContain('status');
    expect(names).not.toContain('pr-create');
    expect(names).not.toContain('pr-retarget');
    expect(names).not.toContain('pr-merge');
    expect(names).not.toContain('review-request');
    expect(names).not.toContain('submodule');
  });

  it('reviewer can access read-assignment, status-query, and tool-request only', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('reviewer');
    expect(names).toContain('read-assignment');
    expect(names).toContain('status-query');
    expect(names).toContain('tool-request');
    expect(names).toHaveLength(3);
  });

  it('reviewer cannot access writer or orchestrator tools', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('reviewer');
    expect(names).not.toContain('commit');
    expect(names).not.toContain('push');
    expect(names).not.toContain('compile');
    expect(names).not.toContain('test');
    expect(names).not.toContain('assign');
    expect(names).not.toContain('dispatch');
  });

  it('orchestrator can access all 16 tools', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('orchestrator');
    expect(names).toHaveLength(16);
  });

  it('calling createDefaultRegistry twice creates independent registries', () => {
    const r1 = createDefaultRegistry();
    const r2 = createDefaultRegistry();
    expect(r1).not.toBe(r2);
    expect(r1.size).toBe(r2.size);
  });
});
