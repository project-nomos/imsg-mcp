/**
 * Errors from the `imsg rpc` bridge, classified so tools can return a useful message
 * and callers know whether retrying is safe.
 */
export type ImsgErrorKind =
  /** Full Disk Access (or Automation) is missing. Fix permissions; retrying won't help. */
  | "permission"
  /** The call took longer than the timeout. */
  | "timeout"
  /** The child exited while the call was in flight, or is restarting. */
  | "unavailable"
  /** The Messages database is temporarily unavailable (imsg -32002). */
  | "database_unavailable"
  /** imsg rejected the params (-32602). A bug on our side or an unknown chat. */
  | "invalid_params"
  /** imsg does not know the method (-32601). */
  | "method_not_found"
  /** A send may or may not have gone out (imsg -32001/-32004). Never retry automatically. */
  | "delivery_unknown"
  /** Anything else imsg reported. */
  | "rpc";

export class ImsgError extends Error {
  constructor(
    message: string,
    readonly kind: ImsgErrorKind,
    readonly retryable: boolean,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ImsgError";
  }

  /** True when imsg says the operation was never dispatched, so a retry cannot duplicate it. */
  get notStarted(): boolean {
    const d = this.data as { disposition?: unknown; retry_safe?: unknown } | undefined;
    return (
      !!d && typeof d === "object" && (d.retry_safe === true || d.disposition === "not_started")
    );
  }
}

export interface JsonRpcErrorObject {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

function dataText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.detail === "string") return d.detail;
    if (typeof d.message === "string") return d.message;
  }
  return "";
}

const PERMISSION_PATTERNS = [
  /authorization denied/i,
  /full disk access/i,
  /not authorized to send apple events/i,
  /operation not permitted/i,
  /\(-1743\)/,
];

export function permissionHint(binary: string): string {
  return (
    `imsg cannot read the Messages database. Grant Full Disk Access (and Automation → Messages) ` +
    `to ${binary} in System Settings → Privacy & Security, then restart the service.`
  );
}

/** Builds an ImsgError from a JSON-RPC error object returned by `imsg rpc`. */
export function fromRpcError(method: string, err: JsonRpcErrorObject): ImsgError {
  const code = typeof err.code === "number" ? err.code : undefined;
  const message = typeof err.message === "string" ? err.message : "imsg error";
  const detail = dataText(err.data);
  const firstLine = (detail.split("\n").find((l) => l.trim()) ?? "").trim();
  const summary = firstLine && firstLine !== message ? `${message}: ${firstLine}` : message;

  if (PERMISSION_PATTERNS.some((re) => re.test(detail) || re.test(message))) {
    return new ImsgError(
      `${method}: permission denied (${firstLine || message})`,
      "permission",
      false,
      code,
      err.data,
    );
  }
  switch (code) {
    case -32002:
      return new ImsgError(
        `${method}: Messages database unavailable (${summary})`,
        "database_unavailable",
        true,
        code,
        err.data,
      );
    case -32001:
    case -32004:
      return new ImsgError(
        `${method}: delivery outcome unknown (${summary})`,
        "delivery_unknown",
        false,
        code,
        err.data,
      );
    case -32602:
      return new ImsgError(
        `${method}: invalid params (${summary})`,
        "invalid_params",
        false,
        code,
        err.data,
      );
    case -32601:
      return new ImsgError(
        `${method}: method not found`,
        "method_not_found",
        false,
        code,
        err.data,
      );
    case -32000:
      return new ImsgError(
        `${method}: imsg is busy (${summary})`,
        "unavailable",
        true,
        code,
        err.data,
      );
    default:
      return new ImsgError(`${method}: ${summary}`, "rpc", false, code, err.data);
  }
}
