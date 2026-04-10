import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../types/context.js';
import type { ProtocolRole } from '../types/role.js';
import { PROTOCOL_ROLES } from '../types/role.js';
import { exec } from '../util/exec.js';

/**
 * Build a ToolContext from LOOM_* environment variables.
 *
 * Used by the MCP server to construct the context passed to every tool
 * handler. Missing identity vars (LOOM_AGENT_ID, LOOM_SESSION_ID) log
 * a warning but don't prevent startup — allows standalone use without
 * full LOOM orchestration.
 */
export async function contextFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<ToolContext> {
  const agentId = env.LOOM_AGENT_ID ?? 'unknown';
  const sessionId = env.LOOM_SESSION_ID ?? randomUUID();
  const worktree = env.LOOM_WORKTREE ?? process.cwd();

  if (!env.LOOM_AGENT_ID) {
    process.stderr.write(
      'warn: LOOM_AGENT_ID not set, defaulting to "unknown"\n',
    );
  }
  if (!env.LOOM_SESSION_ID) {
    process.stderr.write(
      'warn: LOOM_SESSION_ID not set, generating random UUID\n',
    );
  }

  const rawRole = env.LOOM_ROLE;
  let role: ProtocolRole;
  if (!rawRole || rawRole.trim() === '') {
    // No role set — standalone use, default to orchestrator.
    role = 'orchestrator';
  } else if (isProtocolRole(rawRole)) {
    role = rawRole;
  } else {
    // Invalid role value — fail closed to least privilege.
    process.stderr.write(
      `warn: LOOM_ROLE '${rawRole}' is not a valid role, defaulting to 'writer'\n`,
    );
    role = 'writer';
  }

  // Don't shell out to git during startup — MCP servers may be
  // sandboxed and unable to spawn child processes. Infer lazily
  // when a tool handler actually needs ctx.branch.
  const branch = env.LOOM_BRANCH ?? 'unknown';

  const scope = parseCommaSeparated(env.LOOM_SCOPE);
  const scopeDenied = parseCommaSeparated(env.LOOM_SCOPE_DENIED);

  return {
    agentId,
    sessionId,
    role,
    branch,
    worktree,
    scope,
    scopeDenied,
    // No-op in phase 1. Event streaming is phase 3.
    emit: async () => {},
  };
}

function isProtocolRole(value: string): value is ProtocolRole {
  return (PROTOCOL_ROLES as readonly string[]).includes(value);
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function inferBranch(cwd: string): Promise<string> {
  const result = await exec(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd,
  );
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  return 'unknown';
}
