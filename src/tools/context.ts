import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App } from "../app";
import type { Identity } from "../auth/access";
import { ImsgError, permissionHint } from "../imsg/errors";
import type { AuditRecord } from "../log/audit";
import { SendRefused } from "../send/rules";
import { SendDisabled, SendFailed, SendInputError } from "../send/service";

export interface ToolContext {
  app: App;
  identity: Identity;
}

/** A problem with the caller's input. The message goes back to the model as-is. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface ToolOutput {
  result: object;
  /** Extra audit fields: chat ids and row counts for reads. Never message text. */
  audit?: Partial<AuditRecord>;
}

function errorMessage(err: unknown, ctx: ToolContext): string {
  if (
    err instanceof ToolInputError ||
    err instanceof SendInputError ||
    err instanceof SendRefused ||
    err instanceof SendDisabled
  ) {
    return err.message;
  }
  if (err instanceof SendFailed) return err.message;
  if (err instanceof ImsgError) {
    switch (err.kind) {
      case "permission":
        return permissionHint(ctx.app.binaryPath);
      case "timeout":
      case "unavailable":
      case "database_unavailable":
        // While imsg restarts to re-check permissions, keep pointing at the real problem.
        if (ctx.app.watcher.permissionDenied) return permissionHint(ctx.app.binaryPath);
        return `Messages is temporarily unavailable (${err.message}). Try again in a few seconds.`;
      default:
        return `imsg error: ${err.message}`;
    }
  }
  return `Internal error: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Runs a tool body, writes one audit record, and turns errors into tool errors
 * (`isError: true`) that tell the model what went wrong.
 */
export async function runTool(
  ctx: ToolContext,
  tool: string,
  body: () => Promise<ToolOutput>,
  opts: { audit?: boolean } = {},
): Promise<CallToolResult> {
  const started = ctx.app.now();
  const base = { identity: ctx.identity.id, identity_kind: ctx.identity.kind, tool };
  try {
    const { result, audit } = await body();
    if (opts.audit !== false) {
      ctx.app.audit.record({
        ...base,
        status: "ok",
        duration_ms: ctx.app.now() - started,
        ...audit,
      });
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    const message = errorMessage(err, ctx);
    if (opts.audit !== false) {
      ctx.app.audit.record({
        ...base,
        status: err instanceof SendRefused ? "refused" : "error",
        duration_ms: ctx.app.now() - started,
        error: message.slice(0, 500),
      });
    }
    if (
      !(err instanceof ToolInputError) &&
      !(err instanceof SendInputError) &&
      !(err instanceof SendRefused)
    ) {
      ctx.app.logger.warn("tool failed", {
        tool,
        identity: ctx.identity.id,
        error: message.slice(0, 300),
      });
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/** Parses an ISO 8601 input into a canonical UTC string imsg accepts. */
export function parseIsoInput(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ToolInputError(`${name} must be an ISO 8601 date-time, such as 2026-11-13T18:00:00Z`);
  }
  return ms;
}

export function uniqueChatIds(items: { chat_id: number }[]): number[] {
  return [...new Set(items.map((i) => i.chat_id))];
}
