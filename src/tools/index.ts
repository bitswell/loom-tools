import { ToolRegistry } from '../registry.js';
import { commitTool } from './commit.js';
import { pushTool } from './push.js';
import { readAssignmentTool } from './read-assignment.js';
import { compileTool } from './compile.js';
import { testTool } from './test.js';
import { statusQueryTool } from './status-query.js';
import { assignTool } from './assign.js';
import { dispatchTool } from './dispatch.js';
import { waitTool } from './wait.js';
import { statusTool } from './status.js';
import { prCreateTool } from './pr-create.js';
import { prRetargetTool } from './pr-retarget.js';
import { prMergeTool } from './pr-merge.js';
import { reviewRequestTool } from './review-request.js';
import { submoduleTool } from './submodule.js';
import { toolRequestTool } from './tool-request.js';
import { ciGenerateTool } from './ci-generate.js';
import { repoInitTool } from './repo-init.js';
import { complianceCheckTool } from './compliance-check.js';

// Phase 2 exports
export { commitTool } from './commit.js';
export { pushTool } from './push.js';
export { readAssignmentTool } from './read-assignment.js';
export { compileTool } from './compile.js';
export { testTool } from './test.js';
export { statusQueryTool } from './status-query.js';

// Phase 3 exports
export { assignTool } from './assign.js';
export { dispatchTool } from './dispatch.js';
export { waitTool } from './wait.js';
export { statusTool } from './status.js';
export { prCreateTool } from './pr-create.js';
export { prRetargetTool } from './pr-retarget.js';
export { prMergeTool } from './pr-merge.js';
export { reviewRequestTool } from './review-request.js';
export { submoduleTool } from './submodule.js';
export { toolRequestTool } from './tool-request.js';

// Phase 4 exports
export { ciGenerateTool, generateCiFiles } from './ci-generate.js';
export { repoInitTool } from './repo-init.js';
export { complianceCheckTool, parseOwnerRepo } from './compliance-check.js';

/**
 * Create a registry with all built-in LOOM tools registered.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Phase 2 tools
  registry.register(commitTool);
  registry.register(pushTool);
  registry.register(readAssignmentTool);
  registry.register(compileTool);
  registry.register(testTool);
  registry.register(statusQueryTool);

  // Phase 3 — lifecycle tools (orchestrator only)
  registry.register(assignTool);
  registry.register(dispatchTool);
  registry.register(waitTool);
  registry.register(statusTool);

  // Phase 3 — workflow tools (orchestrator only)
  registry.register(prCreateTool);
  registry.register(prRetargetTool);
  registry.register(prMergeTool);
  registry.register(reviewRequestTool);
  registry.register(submoduleTool);

  // Phase 3 — self-service (all roles)
  registry.register(toolRequestTool);

  // Phase 4 — repo management tools (orchestrator only)
  registry.register(ciGenerateTool);
  registry.register(repoInitTool);
  registry.register(complianceCheckTool);

  return registry;
}
