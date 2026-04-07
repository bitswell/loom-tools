import { ToolRegistry } from '../registry.js';
import { commitTool } from './commit.js';
import { pushTool } from './push.js';
import { readAssignmentTool } from './read-assignment.js';
import { compileTool } from './compile.js';
import { testTool } from './test.js';
import { statusQueryTool } from './status-query.js';

export { commitTool } from './commit.js';
export { pushTool } from './push.js';
export { readAssignmentTool } from './read-assignment.js';
export { compileTool } from './compile.js';
export { testTool } from './test.js';
export { statusQueryTool } from './status-query.js';

/**
 * Create a registry with all built-in LOOM tools registered.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(commitTool);
  registry.register(pushTool);
  registry.register(readAssignmentTool);
  registry.register(compileTool);
  registry.register(testTool);
  registry.register(statusQueryTool);
  return registry;
}
