import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createDefaultRegistry } from '../tools/index.js';
import { canAccess } from '../types/role.js';
import { contextFromEnv } from './context-from-env.js';
import type { ToolContext } from '../types/context.js';
import type { ToolRegistry } from '../registry.js';

/**
 * Create and start a stdio-based MCP server that exposes all
 * registered loom-tools as MCP tools.
 *
 * The server reads agent identity from LOOM_* environment variables,
 * enforces role-based access control, and maps tool results to MCP
 * response format. It never crashes on a single tool failure.
 */
export async function startServer(): Promise<void> {
  const registry = createDefaultRegistry();
  const ctx = await contextFromEnv();

  const server = new Server(
    { name: 'loom-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  registerToolListHandler(server, registry);
  registerToolCallHandler(server, registry, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Handle tools/list: return all registered tools with JSON Schema
 * input definitions.
 */
function registerToolListHandler(
  server: Server,
  registry: ToolRegistry,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry.all().map((tool) => {
      const def = tool.definition;
      const jsonSchema = zodToJsonSchema(def.inputSchema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      });

      // Remove the top-level $schema and additionalProperties wrapper
      // that zod-to-json-schema adds — MCP expects a clean JSON Schema
      // object for inputSchema.
      const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;

      return {
        name: def.name,
        description: def.description,
        inputSchema: schema as Record<string, unknown>,
      };
    });

    return { tools };
  });
}

/**
 * Handle tools/call: look up tool, enforce role, validate input,
 * invoke handler, map result to MCP format.
 *
 * Never throws — maps all errors to MCP error responses so the
 * server keeps listening.
 */
function registerToolCallHandler(
  server: Server,
  registry: ToolRegistry,
  ctx: ToolContext,
): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // 1. Look up tool
    const tool = registry.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // 2. Role enforcement
    if (!canAccess(ctx.role, tool.definition.roles)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Role '${ctx.role}' cannot invoke '${name}'. Requires: ${tool.definition.roles.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    // 3. Validate input against Zod schema
    const parsed = tool.definition.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Input validation failed: ${parsed.error.message}`,
          },
        ],
        isError: true,
      };
    }

    // 4. Invoke handler
    try {
      const result = await tool.handler(parsed.data, ctx);

      if (result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.error, null, 2),
            },
          ],
          isError: !result.error.retryable,
        };
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Handler error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });
}

// When run directly, start the server.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('mcp-server.js');

if (isDirectRun) {
  startServer().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
}
