import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { canAccess, type ProtocolRole } from '../../src/types/role.js';
import { ToolRegistry } from '../../src/registry.js';
import type { Tool, ToolDefinition } from '../../src/types/tool.js';
import { ok } from '../../src/types/result.js';
import { WRITER_TOOLS } from '../../src/roles/writer.js';
import { REVIEWER_TOOLS } from '../../src/roles/reviewer.js';
import { ORCHESTRATOR_TOOLS } from '../../src/roles/orchestrator.js';

// ── Test helpers ──────────────────────────────────────────────────────────

function makeTool(name: string, roles: readonly ProtocolRole[]): Tool {
  const definition: ToolDefinition = {
    name,
    description: `Test tool: ${name}`,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    roles,
  };
  return {
    definition,
    handler: async () => ok({}),
  };
}

// ── canAccess tests ───────────────────────────────────────────────────────

describe('canAccess', () => {
  it('orchestrator can access any tool', () => {
    expect(canAccess('orchestrator', ['writer'])).toBe(true);
    expect(canAccess('orchestrator', ['reviewer'])).toBe(true);
    expect(canAccess('orchestrator', ['orchestrator'])).toBe(true);
    expect(canAccess('orchestrator', [])).toBe(true);
  });

  it('writer can access writer-scoped tools', () => {
    expect(canAccess('writer', ['writer'])).toBe(true);
    expect(canAccess('writer', ['writer', 'orchestrator'])).toBe(true);
  });

  it('writer cannot access orchestrator-only tools', () => {
    expect(canAccess('writer', ['orchestrator'])).toBe(false);
  });

  it('writer cannot access reviewer-only tools', () => {
    expect(canAccess('writer', ['reviewer'])).toBe(false);
  });

  it('reviewer can access reviewer-scoped tools', () => {
    expect(canAccess('reviewer', ['reviewer'])).toBe(true);
    expect(canAccess('reviewer', ['reviewer', 'writer'])).toBe(true);
  });

  it('reviewer cannot access writer-only tools', () => {
    expect(canAccess('reviewer', ['writer'])).toBe(false);
  });

  it('reviewer cannot access orchestrator-only tools', () => {
    expect(canAccess('reviewer', ['orchestrator'])).toBe(false);
  });
});

// ── ToolRegistry tests ────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const reg = new ToolRegistry();
    const tool = makeTool('commit', ['writer', 'orchestrator']);
    reg.register(tool);

    expect(reg.get('commit')).toBe(tool);
    expect(reg.size).toBe(1);
  });

  it('rejects duplicate tool names', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('commit', ['writer']));

    expect(() => reg.register(makeTool('commit', ['writer']))).toThrow(
      "Tool 'commit' is already registered",
    );
  });

  it('returns undefined for unknown tools', () => {
    const reg = new ToolRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('lists all tools', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('commit', ['writer']));
    reg.register(makeTool('assign', ['orchestrator']));
    reg.register(makeTool('status-query', ['writer', 'reviewer', 'orchestrator']));

    expect(reg.all()).toHaveLength(3);
  });
});

// ── Role filtering tests ──────────────────────────────────────────────────

describe('ToolRegistry.forRole', () => {
  function buildFullRegistry(): ToolRegistry {
    const reg = new ToolRegistry();

    // Writer + orchestrator tools
    reg.register(makeTool('commit', ['writer', 'orchestrator']));
    reg.register(makeTool('push', ['writer', 'orchestrator']));
    reg.register(makeTool('compile', ['writer', 'orchestrator']));
    reg.register(makeTool('test', ['writer', 'orchestrator']));

    // All roles
    reg.register(makeTool('read-assignment', ['writer', 'reviewer', 'orchestrator']));
    reg.register(makeTool('status-query', ['writer', 'reviewer', 'orchestrator']));
    reg.register(makeTool('tool-request', ['writer', 'reviewer', 'orchestrator']));

    // Orchestrator only
    reg.register(makeTool('assign', ['orchestrator']));
    reg.register(makeTool('dispatch', ['orchestrator']));
    reg.register(makeTool('wait', ['orchestrator']));
    reg.register(makeTool('status', ['orchestrator']));
    reg.register(makeTool('pr-create', ['orchestrator']));
    reg.register(makeTool('pr-retarget', ['orchestrator']));
    reg.register(makeTool('pr-merge', ['orchestrator']));
    reg.register(makeTool('review-request', ['orchestrator']));
    reg.register(makeTool('submodule', ['orchestrator']));

    return reg;
  }

  it('writer gets only writer-accessible tools', () => {
    const reg = buildFullRegistry();
    const names = reg.namesForRole('writer');

    // Should include
    expect(names).toContain('commit');
    expect(names).toContain('push');
    expect(names).toContain('compile');
    expect(names).toContain('test');
    expect(names).toContain('read-assignment');
    expect(names).toContain('status-query');
    expect(names).toContain('tool-request');

    // Should NOT include orchestrator-only
    expect(names).not.toContain('assign');
    expect(names).not.toContain('dispatch');
    expect(names).not.toContain('wait');
    expect(names).not.toContain('status');
    expect(names).not.toContain('pr-create');
    expect(names).not.toContain('pr-retarget');
    expect(names).not.toContain('pr-merge');
    expect(names).not.toContain('review-request');
    expect(names).not.toContain('submodule');

    expect(names).toHaveLength(7);
  });

  it('reviewer gets only read-only tools', () => {
    const reg = buildFullRegistry();
    const names = reg.namesForRole('reviewer');

    expect(names).toContain('read-assignment');
    expect(names).toContain('status-query');
    expect(names).toContain('tool-request');

    // No write tools
    expect(names).not.toContain('commit');
    expect(names).not.toContain('push');
    expect(names).not.toContain('compile');
    expect(names).not.toContain('test');

    expect(names).toHaveLength(3);
  });

  it('orchestrator gets everything', () => {
    const reg = buildFullRegistry();
    const names = reg.namesForRole('orchestrator');

    expect(names).toHaveLength(reg.size);
  });

  it('writer tool count matches WRITER_TOOLS constant', () => {
    const reg = buildFullRegistry();
    const writerNames = reg.namesForRole('writer');

    for (const tool of WRITER_TOOLS) {
      expect(writerNames).toContain(tool);
    }
    expect(writerNames).toHaveLength(WRITER_TOOLS.length);
  });

  it('reviewer tool count matches REVIEWER_TOOLS constant', () => {
    const reg = buildFullRegistry();
    const reviewerNames = reg.namesForRole('reviewer');

    for (const tool of REVIEWER_TOOLS) {
      expect(reviewerNames).toContain(tool);
    }
    expect(reviewerNames).toHaveLength(REVIEWER_TOOLS.length);
  });
});

// ── Role constant consistency ─────────────────────────────────────────────

describe('role constants', () => {
  it('WRITER_TOOLS is a subset of ORCHESTRATOR_TOOLS', () => {
    for (const tool of WRITER_TOOLS) {
      expect(ORCHESTRATOR_TOOLS).toContain(tool);
    }
  });

  it('REVIEWER_TOOLS is a subset of ORCHESTRATOR_TOOLS', () => {
    for (const tool of REVIEWER_TOOLS) {
      expect(ORCHESTRATOR_TOOLS).toContain(tool);
    }
  });

  it('REVIEWER_TOOLS is a subset of WRITER_TOOLS (reviewers can do less than writers)', () => {
    for (const tool of REVIEWER_TOOLS) {
      expect(WRITER_TOOLS).toContain(tool);
    }
  });

  it('no duplicate tool names in ORCHESTRATOR_TOOLS', () => {
    const unique = new Set(ORCHESTRATOR_TOOLS);
    expect(unique.size).toBe(ORCHESTRATOR_TOOLS.length);
  });
});
