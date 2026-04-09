import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../../src/tools/index.js';
import { ToolRegistry } from '../../src/registry.js';
import { commitTool } from '../../src/tools/commit.js';
import type { ProtocolRole } from '../../src/types/role.js';

const VALID_ROLES = new Set<ProtocolRole>([
  'writer',
  'reviewer',
  'orchestrator',
]);

describe('createDefaultRegistry', () => {
  it('every tool has a unique name', () => {
    const tools = createDefaultRegistry().all();
    const names = tools.map((t) => t.definition.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool name is kebab-case', () => {
    for (const t of createDefaultRegistry().all()) {
      expect(t.definition.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('every tool has a non-empty roles array', () => {
    for (const t of createDefaultRegistry().all()) {
      expect(Array.isArray(t.definition.roles)).toBe(true);
      expect(t.definition.roles.length).toBeGreaterThan(0);
    }
  });

  it('every tool role is a valid ProtocolRole', () => {
    for (const t of createDefaultRegistry().all()) {
      for (const r of t.definition.roles) {
        expect(VALID_ROLES.has(r)).toBe(true);
      }
    }
  });

  it('every tool has a meaningful description', () => {
    for (const t of createDefaultRegistry().all()) {
      expect(typeof t.definition.description).toBe('string');
      expect(t.definition.description.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('every tool has input and output Zod schemas', () => {
    for (const t of createDefaultRegistry().all()) {
      expect(t.definition.inputSchema).toBeDefined();
      expect(typeof t.definition.inputSchema.parse).toBe('function');
      expect(t.definition.outputSchema).toBeDefined();
      expect(typeof t.definition.outputSchema.parse).toBe('function');
    }
  });

  it('every tool has a handler function', () => {
    for (const t of createDefaultRegistry().all()) {
      expect(typeof t.handler).toBe('function');
    }
  });

  it('forRole(writer) returns exactly the tools whose roles include writer', () => {
    const registry = createDefaultRegistry();
    const expected = registry
      .all()
      .filter((t) => t.definition.roles.includes('writer'));
    expect(registry.forRole('writer')).toEqual(expected);
  });

  it('forRole(reviewer) returns exactly the tools whose roles include reviewer', () => {
    const registry = createDefaultRegistry();
    const expected = registry
      .all()
      .filter((t) => t.definition.roles.includes('reviewer'));
    expect(registry.forRole('reviewer')).toEqual(expected);
  });

  it('forRole(orchestrator) returns every registered tool', () => {
    const registry = createDefaultRegistry();
    expect(registry.forRole('orchestrator')).toEqual(registry.all());
  });

  it('writer-only tools never leak into reviewer scope', () => {
    const registry = createDefaultRegistry();
    const reviewerNames = registry.namesForRole('reviewer');
    for (const t of registry.all()) {
      const isWriter = t.definition.roles.includes('writer');
      const isReviewer = t.definition.roles.includes('reviewer');
      if (isWriter && !isReviewer) {
        expect(reviewerNames).not.toContain(t.definition.name);
      }
    }
  });

  it('orchestrator-only tools are not exposed to writer or reviewer', () => {
    const registry = createDefaultRegistry();
    const writerNames = registry.namesForRole('writer');
    const reviewerNames = registry.namesForRole('reviewer');
    for (const t of registry.all()) {
      const roles = t.definition.roles;
      if (roles.length === 1 && roles[0] === 'orchestrator') {
        expect(writerNames).not.toContain(t.definition.name);
        expect(reviewerNames).not.toContain(t.definition.name);
      }
    }
  });

  it('registering the same tool twice throws', () => {
    const r = new ToolRegistry();
    r.register(commitTool);
    expect(() => r.register(commitTool)).toThrow(/already registered/);
  });

  it('get() returns undefined for an unknown name', () => {
    expect(createDefaultRegistry().get('does-not-exist')).toBeUndefined();
  });

  it('calling createDefaultRegistry twice creates independent registries', () => {
    const r1 = createDefaultRegistry();
    const r2 = createDefaultRegistry();
    expect(r1).not.toBe(r2);
    expect(r1.size).toBe(r2.size);
  });
});
