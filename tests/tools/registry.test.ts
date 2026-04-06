import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../../src/tools/index.js';

describe('createDefaultRegistry', () => {
  it('registers all 6 built-in tools', () => {
    const registry = createDefaultRegistry();
    expect(registry.size).toBe(6);
  });

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

  it('writer can access commit, push, compile, test, read-assignment, status-query', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('writer');
    expect(names).toContain('commit');
    expect(names).toContain('push');
    expect(names).toContain('compile');
    expect(names).toContain('test');
    expect(names).toContain('read-assignment');
    expect(names).toContain('status-query');
  });

  it('reviewer can access read-assignment and status-query only', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('reviewer');
    expect(names).toContain('read-assignment');
    expect(names).toContain('status-query');
    expect(names).not.toContain('commit');
    expect(names).not.toContain('push');
    expect(names).not.toContain('compile');
    expect(names).not.toContain('test');
  });

  it('orchestrator can access all 6 tools', () => {
    const registry = createDefaultRegistry();
    const names = registry.namesForRole('orchestrator');
    expect(names).toHaveLength(6);
  });

  it('calling createDefaultRegistry twice creates independent registries', () => {
    const r1 = createDefaultRegistry();
    const r2 = createDefaultRegistry();
    expect(r1).not.toBe(r2);
    expect(r1.size).toBe(r2.size);
  });
});
