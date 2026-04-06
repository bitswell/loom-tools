import type { ProtocolRole } from './role.js';
import type { LoomEvent } from './event.js';

/**
 * Runtime context passed to every tool handler.
 *
 * Populated by the runtime adapter (MCP or CLI) from the agent's
 * environment, ASSIGNED commit trailers, and session config.
 */
export interface ToolContext {
  /** Agent identity from commit trailers. */
  agentId: string;

  /** Session UUID, unique per agent invocation. */
  sessionId: string;

  /** The agent's current role in the protocol. */
  role: ProtocolRole;

  /** The agent's branch (e.g., 'loom/ratchet-fix'). */
  branch: string;

  /** The worktree root path. */
  worktree: string;

  /** Allowed file paths from the ASSIGNED commit's Scope trailer. */
  scope: string[];

  /** Denied file paths from the ASSIGNED commit's Scope-Denied trailer. */
  scopeDenied: string[];

  /** Emit an event (implementation provided by the runtime adapter). */
  emit: (event: LoomEvent) => Promise<void>;
}
