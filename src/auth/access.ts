import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Config, Role } from "../config/schema";

/** The header Cloudflare Access adds after it has checked the caller. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type IdentityKind = "person" | "service" | "local";

export interface Identity {
  kind: IdentityKind;
  /** Email for people, service token client id for machines, `local` for stdio. */
  id: string;
  role: Role;
}

export class AccessDenied extends Error {
  constructor(
    /** Logged, never sent to the caller. */
    readonly reason: string,
  ) {
    super("forbidden");
    this.name = "AccessDenied";
  }
}

export interface AccessVerifierOptions {
  teamDomain: string;
  audiences: string[];
  clockToleranceSeconds: number;
  /** Override the JWKS source; tests pass a local key set. */
  keySource?: JWTVerifyGetKey;
}

/**
 * Verifies `Cf-Access-Jwt-Assertion` tokens: RS256 signature against the team's
 * JWKS, then `iss`, `aud`, `exp` and `nbf`. Nothing else about the request is trusted.
 */
export class AccessVerifier {
  private readonly keys: JWTVerifyGetKey;
  readonly issuer: string;

  constructor(private readonly opts: AccessVerifierOptions) {
    this.issuer = `https://${opts.teamDomain}`;
    this.keys =
      opts.keySource ??
      createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`), {
        // Re-fetch at most every 30 s when an unknown `kid` shows up (key rotation).
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 5_000,
      });
  }

  /** Same team and audiences as this verifier? Used to decide whether a reload needs a new one. */
  matches(teamDomain: string, audiences: string[], clockToleranceSeconds: number): boolean {
    return (
      this.opts.teamDomain === teamDomain &&
      this.opts.clockToleranceSeconds === clockToleranceSeconds &&
      this.opts.audiences.length === audiences.length &&
      this.opts.audiences.every((a, i) => a === audiences[i])
    );
  }

  async verify(token: string | null | undefined): Promise<JWTPayload> {
    if (!token) throw new AccessDenied("missing Cf-Access-Jwt-Assertion header");
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ["RS256"],
        issuer: this.issuer,
        audience: this.opts.audiences,
        clockTolerance: this.opts.clockToleranceSeconds,
        requiredClaims: ["exp", "iss", "aud"],
      });
      return payload;
    } catch (err) {
      throw new AccessDenied(describeJoseError(err));
    }
  }
}

function describeJoseError(err: unknown): string {
  if (err instanceof errors.JWTExpired) return "token expired";
  if (err instanceof errors.JWTClaimValidationFailed)
    return `claim "${err.claim}" invalid (${err.reason})`;
  if (err instanceof errors.JWSSignatureVerificationFailed) return "signature verification failed";
  if (err instanceof errors.JWKSNoMatchingKey) return "no matching signing key";
  if (err instanceof errors.JOSEAlgNotAllowed) return "algorithm not allowed";
  if (err instanceof errors.JWKSTimeout) return "timed out fetching Access signing keys";
  if (err instanceof errors.JOSEError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Maps verified claims to a caller. An `email` on `access.people` is a person with the
 * full role. A `common_name` (the service token's client id) listed in
 * `access.service_tokens` is a machine with the role configured for that token.
 */
export function resolveIdentity(payload: JWTPayload, access: Config["access"]): Identity {
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email) {
    if (access.people.includes(email)) return { kind: "person", id: email, role: "full" };
    throw new AccessDenied(`email not in access.people`);
  }
  const commonName = typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  if (commonName) {
    // Own keys only, and only the two valid roles: "constructor" or "__proto__" must not match.
    const role = Object.hasOwn(access.service_tokens, commonName)
      ? access.service_tokens[commonName]
      : undefined;
    if (role === "read" || role === "read_send") return { kind: "service", id: commonName, role };
    throw new AccessDenied(`service token not in access.service_tokens`);
  }
  throw new AccessDenied("token has neither an email nor a common_name claim");
}
