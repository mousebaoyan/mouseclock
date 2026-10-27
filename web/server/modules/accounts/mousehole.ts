import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "../../platform/env.ts";

// Everything said to mousehole: its OAuth and /me, as mousehole's api.md §8.3 lays out.

const REDIRECT_URI = `${env.PUBLIC_URL}/login/callback`;
const TIMEOUT_MS = 10_000;

// `silent`: prompt=none, which comes straight back with login_required for someone not logged
// in to mousehole instead of asking them to.
export function authorizeUrl(state: string, verifier: string, silent: boolean) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.MOUSEHOLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "profile",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  if (silent) params.set("prompt", "none");
  return `${env.MOUSEHOLE_URL}/oauth/authorize?${params}`;
}

const Token = z.object({ access_token: z.string().min(1) });

export async function exchangeCode(code: string, verifier: string) {
  const res = await fetch(`${env.MOUSEHOLE_URL}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: env.MOUSEHOLE_CLIENT_ID,
      client_secret: env.MOUSEHOLE_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Mousehole's token endpoint answered ${res.status}`);
  return Token.parse(await res.json()).access_token;
}

const Profile = z.object({
  id: z.number().int(),
  display_name: z.string(),
  // Relative to mousehole's site; null until it has fetched one.
  avatar_url: z.string().nullable(),
  level: z.number().int().min(0).max(5),
  role: z.enum(["user", "moderator", "admin", "owner"]),
  member_status: z.enum(["member", "frozen"]),
  restriction: z
    .object({ type: z.enum(["mute", "ban"]), until: z.number().int().nullable() })
    .nullable(),
  qq: z.number().int().nullable(),
});
export type Profile = z.infer<typeof Profile>;

// Null once the token is no good: the person was banned, or took the access back.
export async function fetchProfile(token: string) {
  const res = await fetch(`${env.MOUSEHOLE_URL}/api/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Mousehole's /me answered ${res.status}`);
  return Profile.parse(await res.json());
}
