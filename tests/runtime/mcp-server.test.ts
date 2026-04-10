import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createDefaultRegistry } from '../../src/tools/index.js';
import { canAccess } from '../../src/types/role.js';
import type { ToolContext } from '../../src/types/context.js';
import type { ToolRegistry } from '../../src/registry.js';

/**
 * Build a test ToolContext with given overrides.
 */
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'test-agent',
    sessionId: 'test-session',
    role: 'orchestrator',
    branch: 'main',
    worktree: '/tmp/test',
    scope: [],
    scopeDenied: [],
    emit: async () => {},
    ...overrides,
  };
}

/**
 * Exercise the tool list handler logic directly without spawning a
 * child process. This tests the mapping from registry to MCP format.
 */
describe('tools/list', () => {
  it('registry contains all 21 tools', () => {
    const registry = createDefaultRegistry();
    expect(registry.all()).toHaveLength(21);
  });

  it('orchestrator sees all 21 tools', () => {
    const registry = createDefaultRegistry();
    const tools = registry.forRole('orchestrator').map((tool) => {
      const def = tool.definition;
      const jsonSchema = zodToJsonSchema(def.inputSchema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      });
      const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;

      return {
        name: def.name,
        description: def.description,
        inputSchema: schema,
      };
    });

    expect(tools).toHaveLength(21);

    // Every tool has required fields
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as Record<string, unknown>).type).toBe(
        'object',
      );
    }
  });

  it('writer sees fewer tools than orchestrator', () => {
    const registry = createDefaultRegistry();
    const writerTools = registry.forRole('writer');
    const allTools = registry.all();

    expect(writerTools.length).toBeLessThan(allTools.length);
    expect(writerTools.length).toBeGreaterThan(0);

    // Writer should not see orchestrator-only tools
    const writerNames = writerTools.map((t) => t.definition.name);
    expect(writerNames).not.toContain('assign');
    expect(writerNames).not.toContain('dispatch');
    expect(writerNames).not.toContain('pr-merge');

    // Writer should see writer-scoped tools
    expect(writerNames).toContain('commit');
    expect(writerNames).toContain('push');
    expect(writerNames).toContain('read-assignment');
  });

  it('reviewer sees only read-only tools', () => {
    const registry = createDefaultRegistry();
    const reviewerTools = registry.forRole('reviewer');
    const reviewerNames = reviewerTools.map((t) => t.definition.name);

    expect(reviewerNames).toContain('read-assignment');
    expect(reviewerNames).toContain('status-query');
    expect(reviewerNames).not.toContain('commit');
    expect(reviewerNames).not.toContain('push');
    expect(reviewerNames).not.toContain('assign');
  });

  it('includes all known tool names', () => {
    const registry = createDefaultRegistry();
    const names = registry.all().map((t) => t.definition.name);

    const expected = [
      'commit',
      'push',
      'read-assignment',
      'compile',
      'test',
      'status-query',
      'assign',
      'dispatch',
      'wait',
      'status',
      'pr-create',
      'pr-retarget',
      'pr-merge',
      'review-request',
      'submodule',
      'tool-request',
      'ci-generate',
      'repo-init',
      'compliance-check',
      'trailer-validate',
      'lifecycle-check',
    ];

    expect(names.sort()).toEqual(expected.sort());
  });
});

/**
 * Test role enforcement: a tool invocation must be rejected if the
 * agent's role is not in the tool's allowed roles.
 */
describe('role enforcement', () => {
  it('orchestrator can access all tools', () => {
    const registry = createDefaultRegistry();
    const tools = registry.all();

    for (const tool of tools) {
      expect(canAccess('orchestrator', tool.definition.roles)).toBe(true);
    }
  });

  it('writer cannot access orchestrator-only tools', () => {
    const registry = createDefaultRegistry();

    // 'assign' is orchestrator-only
    const assignTool = registry.get('assign');
    expect(assignTool).toBeDefined();
    expect(canAccess('writer', assignTool!.definition.roles)).toBe(false);
  });

  it('reviewer cannot access writer tools', () => {
    const registry = createDefaultRegistry();

    // 'commit' requires writer or orchestrator
    const commitTool = registry.get('commit');
    expect(commitTool).toBeDefined();
    expect(canAccess('reviewer', commitTool!.definition.roles)).toBe(false);
  });

  it('writer can access writer-scoped tools', () => {
    const registry = createDefaultRegistry();

    const commitTool = registry.get('commit');
    expect(commitTool).toBeDefined();
    expect(canAccess('writer', commitTool!.definition.roles)).toBe(true);
  });
});

/**
 * Test the tool call flow: input validation, role check, handler
 * invocation, and error mapping.
 */
describe('tools/call flow', () => {
  it('rejects unknown tool name', async () => {
    const registry = createDefaultRegistry();
    const tool = registry.get('nonexistent-tool');
    expect(tool).toBeUndefined();
  });

  it('rejects call when role is not permitted', async () => {
    const registry = createDefaultRegistry();
    const ctx = makeCtx({ role: 'reviewer' });

    // 'commit' is writer + orchestrator only
    const tool = registry.get('commit')!;
    const permitted = canAccess(ctx.role, tool.definition.roles);

    expect(permitted).toBe(false);
  });

  it('validates input against Zod schema', async () => {
    const registry = createDefaultRegistry();
    const tool = registry.get('commit')!;

    // commit requires at least `message: string`
    const badInput = tool.definition.inputSchema.safeParse({});
    expect(badInput.success).toBe(false);

    const goodInput = tool.definition.inputSchema.safeParse({
      message: 'test commit',
    });
    expect(goodInput.success).toBe(true);
  });

  it('maps handler errors to error response without crashing', async () => {
    const registry = createDefaultRegistry();
    const ctx = makeCtx();

    // Call a tool that will fail because worktree is not a real repo
    const tool = registry.get('read-assignment')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);

    // Handler should return an error result, not throw
    const result = await tool.handler(parsed.data, ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBeTruthy();
      expect(typeof result.error.message).toBe('string');
    }
  });
});

/**
 * Test JSON Schema output from zod-to-json-schema for representative
 * tool input schemas.
 */
describe('Zod to JSON Schema conversion', () => {
  it('produces valid JSON Schema for all tools', () => {
    const registry = createDefaultRegistry();

    for (const tool of registry.all()) {
      const schema = zodToJsonSchema(tool.definition.inputSchema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      });

      expect(schema).toBeDefined();
      expect((schema as Record<string, unknown>).type).toBe('object');
    }
  });

  it('preserves .describe() annotations as description fields', () => {
    const registry = createDefaultRegistry();
    const commitTool = registry.get('commit')!;
    const schema = zodToJsonSchema(commitTool.definition.inputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;

    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.message).toBeDefined();
    expect(properties.message.description).toBeTruthy();
  });
});
