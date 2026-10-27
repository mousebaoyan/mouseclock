import type { Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import { fetchProfile, type Profile } from "./mousehole.ts";

export const SESSION_TTL_MS = 90 * 24 * 3600_000;
// Sliding renewal rewrites the session row at most this often.
const RENEW_AFTER_MS = 3600_000;
// Design §6.1: what changes on mousehole shows here within the hour.
const REFRESH_AFTER_MS = 3600_000;

function fromProfile(profile: Profile, token: string) {
  return {
    display_name: profile.display_name,
    avatar_url:
      profile.avatar_url === null ? null : new URL(profile.avatar_url, env.MOUSEHOLE_URL).href,
    level: profile.level,
    role: profile.role,
    frozen: profile.member_status === "frozen",
    // A ban ends the token, which logs them out at the next refresh; until then it keeps them
    // as quiet as a mute.
    muted: profile.restriction !== null,
    muted_until: profile.restriction?.until ? new Date(profile.restriction.until * 1000) : null,
    qq: profile.qq,
    mousehole_token: token,
    synced_at: new Date(),
  };
}

// Returns the new session's token, for the cookie.
export async function login(
  profile: Profile,
  mouseholeToken: string,
  client: { ip: string | null; userAgent: string },
) {
  const values = fromProfile(profile, mouseholeToken);
  const user = await db
    .insertInto("users")
    .values({ mousehole_id: profile.id, ...values })
    .onConflict((oc) => oc.column("mousehole_id").doUpdateSet(values))
    .returning("id")
    .executeTakeFirstOrThrow();
  const token = newToken();
  await db
    .insertInto("sessions")
    .values({
      token_hash: hashToken(token),
      user_id: user.id,
      user_agent: client.userAgent,
      ip: client.ip,
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    })
    .execute();
  return token;
}

export async function resolveSession(token: string) {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id",
      "sessions.last_seen_at",
      "users.id as user_id",
      "users.level",
      "users.role",
      "users.frozen",
      "users.muted",
      "users.muted_until",
      "users.edit_revoked_at",
    ])
    .where("sessions.token_hash", "=", hashToken(token))
    .where("sessions.expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return null;

  const renewed = Date.now() - row.last_seen_at.getTime() > RENEW_AFTER_MS;
  if (renewed) {
    await db
      .updateTable("sessions")
      .set({ last_seen_at: new Date(), expires_at: new Date(Date.now() + SESSION_TTL_MS) })
      .where("id", "=", row.id)
      .execute();
  }
  const viewer: Viewer = {
    id: row.user_id,
    level: row.level,
    role: row.role,
    frozen: row.frozen,
    // A mute that ran out before the next refresh no longer counts.
    muted: row.muted && (row.muted_until === null || row.muted_until > new Date()),
    edit_revoked: row.edit_revoked_at !== null,
  };
  return { id: row.id, viewer, renewed };
}

export async function endSession(sessionId: number) {
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

export async function profileOf(userId: number) {
  return db
    .selectFrom("users")
    .select(["display_name", "avatar_url", "level", "role", "frozen", "muted_until"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
}

// Every person with a session, an hour after their last refresh (design §6.1). One at a time:
// mousehole's server is busy enough.
export async function refreshUsers() {
  const due = await db
    .selectFrom("users")
    .select(["id", "mousehole_token"])
    .where("synced_at", "<", new Date(Date.now() - REFRESH_AFTER_MS))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("sessions")
          .select("sessions.id")
          .whereRef("sessions.user_id", "=", "users.id")
          .where("sessions.expires_at", ">", new Date()),
      ),
    )
    .orderBy("synced_at")
    .execute();
  for (const user of due) {
    const profile = await fetchProfile(user.mousehole_token);
    if (profile) {
      await db
        .updateTable("users")
        .set(fromProfile(profile, user.mousehole_token))
        .where("id", "=", user.id)
        .execute();
    } else {
      await db.deleteFrom("sessions").where("user_id", "=", user.id).execute();
    }
  }
}

export async function clearExpiredSessions() {
  await db.deleteFrom("sessions").where("expires_at", "<", new Date()).execute();
}
