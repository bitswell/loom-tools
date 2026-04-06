import type { z } from 'zod';
import type { ProtocolRole } from './role.js';
import type { EventType } from './event.js';
import type { ToolContext } from './context.js';
import type { ToolResult } from './result.js';

/**
 * A typed tool definition for LOOM agents.
 *
 * Every tool has:
 * - Typed input/output schemas (Zod) for validation
 * - Role scoping — which protocol roles can invoke it
 * - Event declarations — what events it can emit
 * - A handler function that receives validated input + context
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** Unique tool name (kebab-case). */
  name: string;

  /** Human-readable description for LLM tool discovery. */
  description: string;

  /** Zod schema for input validation. */
  inputSchema: z.ZodType<I>;

  /** Zod schema for output validation. */
  outputSchema: z.ZodType<O>;

  /** Which protocol roles can invoke this tool. */
  roles: readonly ProtocolRole[];

  /** Events this tool may emit on completion. */
  emits?: readonly EventType[];
}

/** The function that implements a tool's logic. */
export type ToolHandler<I, O> = (
  input: I,
  ctx: ToolContext,
) => Promise<ToolResult<O>>;

/** A complete tool: definition + handler. */
export interface Tool<I = unknown, O = unknown> {
  definition: ToolDefinition<I, O>;
  handler: ToolHandler<I, O>;
}
