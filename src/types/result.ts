/** Structured result from a tool invocation. */
export type ToolResult<O> = ToolSuccess<O> | ToolError;

export interface ToolSuccess<O> {
  success: true;
  data: O;
}

export interface ToolError {
  success: false;
  error: {
    /** Machine-readable error code (e.g., 'scope-violation', 'compile-failed'). */
    code: string;
    /** Human-readable message. */
    message: string;
    /** Whether the operation can be retried. */
    retryable: boolean;
  };
}

/** Helper to create a success result. */
export function ok<O>(data: O): ToolSuccess<O> {
  return { success: true, data };
}

/** Helper to create an error result. */
export function err(
  code: string,
  message: string,
  retryable = false,
): ToolError {
  return { success: false, error: { code, message, retryable } };
}
