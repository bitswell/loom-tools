import type { Tool } from './types/tool.js';
import type { ProtocolRole } from './types/role.js';
import { canAccess } from './types/role.js';

/**
 * A registry of LOOM tools.
 *
 * Tools register themselves here. The runtime adapters (MCP, CLI)
 * query the registry filtered by the agent's role.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool. Throws if name already taken. */
  register<I, O>(tool: Tool<I, O>): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }
    this.tools.set(name, tool as Tool);
  }

  /** Get a tool by name, or undefined. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools. */
  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Get tools accessible to a given role. */
  forRole(role: ProtocolRole): Tool[] {
    return this.all().filter((t) => canAccess(role, t.definition.roles));
  }

  /** Get tool names accessible to a given role. */
  namesForRole(role: ProtocolRole): string[] {
    return this.forRole(role).map((t) => t.definition.name);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
