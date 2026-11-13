import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";
import { AccessDenied, AccessVerifier, resolveIdentity } from "../../src/auth/access";
import { buildConfig } from "../../src/config/schema";
import { accessKeys, AUD_AGENT, AUD_PEOPLE, OWNER, TEAM } from "../helpers/harness";

let keys: Awaited<ReturnType<typeof accessKeys>>;
let verifier: AccessVerifier;
const access = buildConfig({
  access: {
    team_domain: TEAM,
    aud: [AUD_PEOPLE, AUD_AGENT],
    people: [OWNER],
    service_tokens: { "reader.access": "read", "sender.access": "read_send" },
  },
}).access;

beforeAll(async () => {
  keys = await accessKeys();
  verifier = new AccessVerifier({
    teamDomain: TEAM,
    audiences: [AUD_PEOPLE, AUD_AGENT],
    clockToleranceSeconds: 0,
    keySource: keys.keySource,
  });
});

async function denied(token: string | null): Promise<string> {
  try {
    await verifier.verify(token);
  } catch (err) {
    expect(err).toBeInstanceOf(AccessDenied);
    return (err as AccessDenied).reason;
  }
  throw new Error("expected AccessDenied");
}

describe("JWT validation", () => {
  test("accepts a good token and maps the owner to the full role", async () => {
    const payload = await verifier.verify(await keys.sign({ email: OWNER, type: "app" }));
    expect(resolveIdentity(payload, access)).toEqual({ kind: "person", id: OWNER, role: "full" });
  });

  test("accepts the machine app's AUD", async () => {
    const token = await keys.sign({ common_name: "reader.access", sub: "" }, { aud: AUD_AGENT });
    const identity = resolveIdentity(await verifier.verify(token), access);
    expect(identity).toEqual({ kind: "service", id: "reader.access", role: "read" });
  });

  test("rejects an expired token", async () => {
    const token = await keys.sign({ email: OWNER }, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await denied(token)).toBe("token expired");
  });

  test("rejects the wrong audience", async () => {
    expect(await denied(await keys.sign({ email: OWNER }, { aud: "someone-elses-app" }))).toContain(
      '"aud"',
    );
  });

  test("rejects the wrong issuer", async () => {
    expect(
      await denied(await keys.sign({ email: OWNER }, { iss: "https://evil.cloudflareaccess.com" })),
    ).toContain('"iss"');
  });

  test("rejects a missing header", async () => {
    expect(await denied(null)).toContain("missing");
    expect(await denied("")).toContain("missing");
  });

  test("rejects a token signed with another key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD_PEOPLE)
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await denied(forged)).toBe("signature verification failed");
  });

  test("rejects HS256 and unsigned tokens", async () => {
    const hs = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD_PEOPLE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect(await denied(hs)).toBeTruthy();
    const none = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ email: OWNER }))}.`;
    expect(await denied(none)).toBeTruthy();
  });

  test("rejects a token that is not valid yet", async () => {
    const token = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD_PEOPLE)
      .setNotBefore(Math.floor(Date.now() / 1000) + 600)
      .setExpirationTime("15m")
      .sign(keys.privateKey);
    expect(await denied(token)).toContain('"nbf"');
  });

  test("rejects garbage", async () => {
    expect(await denied("not.a.jwt")).toBeTruthy();
  });
});

describe("identity mapping", () => {
  test("service tokens get their configured role", () => {
    expect(resolveIdentity({ common_name: "sender.access" }, access).role).toBe("read_send");
  });

  test("unknown people and tokens are refused", () => {
    expect(() => resolveIdentity({ email: "stranger@example.com" }, access)).toThrow(AccessDenied);
    expect(() => resolveIdentity({ common_name: "leaked.access" }, access)).toThrow(AccessDenied);
    expect(() => resolveIdentity({ sub: "x" }, access)).toThrow(AccessDenied);
  });

  test("object prototype keys never match a service token", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => resolveIdentity({ common_name: name }, access)).toThrow(AccessDenied);
    }
  });

  test("email matching ignores case", () => {
    expect(resolveIdentity({ email: OWNER.toUpperCase() }, access).id).toBe(OWNER);
  });
});
