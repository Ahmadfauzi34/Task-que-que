import { describe, expect, test } from "bun:test";

import {
  CloudflareAccessServiceVerifier,
  type CloudflareAccessServiceConfig,
} from "../src/cloudflare_access";

const encoder = new TextEncoder();
const TEAM_DOMAIN = "https://reference-team.cloudflareaccess.com";
const AUDIENCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CLIENT_ID = "reference-service.access";
const KID = "test-signing-key";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodedJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function generateSigningMaterial() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid: KID, alg: "RS256", use: "sig" },
  };
}

async function signJwt(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = encodedJson({ alg: "RS256", typ: "JWT", kid: KID });
  const payload = encodedJson(claims);
  const signed = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signed),
  );
  return `${signed}.${base64Url(new Uint8Array(signature))}`;
}

function serviceClaims(nowSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    type: "app",
    aud: [AUDIENCE],
    exp: nowSeconds + 3_600,
    iat: nowSeconds,
    nbf: nowSeconds,
    iss: TEAM_DOMAIN,
    common_name: CLIENT_ID,
    sub: "",
    ...overrides,
  };
}

function verifierConfig(): CloudflareAccessServiceConfig {
  return {
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    serviceTokenClientId: CLIENT_ID,
  };
}

describe("Cloudflare Access service verifier", () => {
  test("verifies RS256 signature, issuer, audience and exact service principal", async () => {
    const nowMs = 2_000_000_000_000;
    const { privateKey, jwk } = await generateSigningMaterial();
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return Response.json({ keys: [jwk] });
    };
    const verifier = new CloudflareAccessServiceVerifier(
      verifierConfig(),
      fetchImpl,
      () => nowMs,
    );

    const assertion = await signJwt(privateKey, serviceClaims(Math.floor(nowMs / 1_000)));
    const first = await verifier.verify(assertion);
    const second = await verifier.verify(assertion);

    expect(first).toEqual({
      ok: true,
      principal: {
        kind: "service",
        scope: `cloudflare-service:${CLIENT_ID}`,
      },
    });
    expect(second.ok).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  test("rejects forged signature and claims outside the configured boundary", async () => {
    const nowMs = 2_000_000_000_000;
    const nowSeconds = Math.floor(nowMs / 1_000);
    const trusted = await generateSigningMaterial();
    const attacker = await generateSigningMaterial();
    const verifier = new CloudflareAccessServiceVerifier(
      verifierConfig(),
      async () => Response.json({ keys: [trusted.jwk] }),
      () => nowMs,
    );

    const forged = await signJwt(attacker.privateKey, serviceClaims(nowSeconds));
    expect(await verifier.verify(forged)).toEqual({ ok: false, reason: "invalid" });

    const wrongAudience = await signJwt(
      trusted.privateKey,
      serviceClaims(nowSeconds, { aud: ["another-audience"] }),
    );
    expect(await verifier.verify(wrongAudience)).toEqual({ ok: false, reason: "invalid" });

    const wrongIssuer = await signJwt(
      trusted.privateKey,
      serviceClaims(nowSeconds, { iss: "https://attacker.cloudflareaccess.com" }),
    );
    expect(await verifier.verify(wrongIssuer)).toEqual({ ok: false, reason: "invalid" });

    const wrongService = await signJwt(
      trusted.privateKey,
      serviceClaims(nowSeconds, { common_name: "another-service.access" }),
    );
    expect(await verifier.verify(wrongService)).toEqual({ ok: false, reason: "invalid" });

    const identityUser = await signJwt(
      trusted.privateKey,
      serviceClaims(nowSeconds, { sub: "user-subject", common_name: undefined }),
    );
    expect(await verifier.verify(identityUser)).toEqual({ ok: false, reason: "invalid" });

    const expired = await signJwt(
      trusted.privateKey,
      serviceClaims(nowSeconds, { exp: nowSeconds - 120 }),
    );
    expect(await verifier.verify(expired)).toEqual({ ok: false, reason: "invalid" });
  });

  test("uses bounded stale signing keys during a temporary JWKS outage", async () => {
    let nowMs = 2_000_000_000_000;
    const nowSeconds = Math.floor(nowMs / 1_000);
    const { privateKey, jwk } = await generateSigningMaterial();
    let online = true;
    let fetchCalls = 0;
    const verifier = new CloudflareAccessServiceVerifier(
      verifierConfig(),
      async () => {
        fetchCalls += 1;
        if (!online) {
          throw new Error("offline");
        }
        return Response.json({ keys: [jwk] });
      },
      () => nowMs,
      1_000,
      10_000,
    );

    const assertion = await signJwt(
      privateKey,
      serviceClaims(nowSeconds, { exp: nowSeconds + 60_000 }),
    );
    expect((await verifier.verify(assertion)).ok).toBe(true);

    online = false;
    nowMs += 2_000;
    expect((await verifier.verify(assertion)).ok).toBe(true);
    expect(fetchCalls).toBe(2);

    nowMs += 20_000;
    expect(await verifier.verify(assertion)).toEqual({ ok: false, reason: "unavailable" });
  });

  test("fails closed when signing keys have never been available", async () => {
    const verifier = new CloudflareAccessServiceVerifier(
      verifierConfig(),
      async () => {
        throw new Error("offline");
      },
      () => 2_000_000_000_000,
    );

    const token = `${encodedJson({ alg: "RS256", typ: "JWT", kid: KID })}.${encodedJson(
      serviceClaims(2_000_000_000),
    )}.${base64Url(new Uint8Array([1, 2, 3]))}`;

    expect(await verifier.verify(token)).toEqual({ ok: false, reason: "unavailable" });
  });
});
