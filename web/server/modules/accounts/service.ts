import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { DB, Users } from "../../../db/types.ts";
import { editRevoked, type Scope, type Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { env } from "../../platform/env.ts";
import { unix } from "../../platform/http.ts";
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
    token_refused_at: null,
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

// Who a session or a personal token is: the columns of users that make a Viewer.
export const viewerColumns = [
  "users.id as user_id",
  "users.level",
  "users.role",
  "users.frozen",
  "users.muted",
  "users.muted_until",
  "users.edit_revoked_at",
] as const;

export function toViewer(
  row: Pick<
    Selectable<Users>,
    "level" | "role" | "frozen" | "muted" | "muted_until" | "edit_revoked_at"
  > & { user_id: number },
): Viewer {
  return {
    id: row.user_id,
    level: row.level,
    role: row.role,
    frozen: row.frozen,
    // A mute that ran out before the next refresh no longer counts.
    muted: row.muted && (row.muted_until === null || row.muted_until > new Date()),
    edit_revoked: row.edit_revoked_at !== null,
  };
}

export async function resolveSession(token: string) {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select(["sessions.id", "sessions.last_seen_at", ...viewerColumns])
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
  return { id: row.id, viewer: toViewer(row), renewed };
}

// Personal tokens for one's own Agent (design §13): up to TOKENS_EACH a person, and one unused for
// TOKEN_UNUSED_DAYS no longer works.
export const TOKENS_EACH = 10;
export const TOKEN_UNUSED_DAYS = 90;
export const TOKEN_REQUESTS_PER_MINUTE = 60;

// Not revoked, and used, or made, within TOKEN_UNUSED_DAYS.
function liveTokens(from: Kysely<DB> = db) {
  return from
    .selectFrom("api_tokens")
    .where("api_tokens.revoked_at", "is", null)
    .where(
      sql`coalesce(api_tokens.last_used_at, api_tokens.created_at)`,
      ">",
      new Date(Date.now() - TOKEN_UNUSED_DAYS * 24 * 3600_000),
    );
}

// Returns the token, which only this once is seen whole.
export async function createApiToken(
  userId: number,
  { name, scope }: { name: string; scope: Scope },
) {
  return db.transaction().execute(async (trx) => {
    // One person's at a time, so two made at once don't both pass the limit.
    await trx
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const { count } = await liveTokens(trx)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("api_tokens.user_id", "=", userId)
      .executeTakeFirstOrThrow();
    if (count >= TOKENS_EACH) {
      throw new AppError(409, "too_many_tokens", `每人最多 ${TOKENS_EACH} 个令牌，先作废不用的`);
    }
    const token = newToken();
    await trx
      .insertInto("api_tokens")
      .values({ user_id: userId, name, scope, token_hash: hashToken(token) })
      .execute();
    return token;
  });
}

export async function listApiTokens(userId: number) {
  const rows = await liveTokens()
    .select(["id", "name", sql<Scope>`scope`.as("scope"), "created_at", "last_used_at"])
    .where("user_id", "=", userId)
    .orderBy("id", "desc")
    .execute();
  return rows.map((row) => ({
    ...row,
    created_at: unix(row.created_at),
    last_used_at: row.last_used_at && unix(row.last_used_at),
  }));
}

export async function revokeApiToken(userId: number, id: number) {
  const row = await db
    .updateTable("api_tokens")
    .set({ revoked_at: new Date() })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "没有这个令牌，或者已经作废了");
}

// Who a live token is, and what it may do; its last use is written at most hourly. One whose
// owner mousehole turned down is no one, though made in the moment before the refresh revoked it.
export async function resolveApiToken(token: string) {
  const row = await liveTokens()
    .innerJoin("users", "users.id", "api_tokens.user_id")
    .select([
      "api_tokens.id",
      sql<Scope>`api_tokens.scope`.as("scope"),
      "api_tokens.last_used_at",
      ...viewerColumns,
    ])
    .where("api_tokens.token_hash", "=", hashToken(token))
    .where("users.token_refused_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > RENEW_AFTER_MS) {
    await db
      .updateTable("api_tokens")
      .set({ last_used_at: new Date() })
      .where("id", "=", row.id)
      .execute();
  }
  return { id: row.id, scope: row.scope, viewer: toViewer(row) };
}

export async function endSession(sessionId: number) {
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

// With how many of their messages they haven't seen, for the bell (design §11.1).
export async function profileOf(userId: number) {
  return db
    .selectFrom("users")
    .select(["display_name", "avatar_url", "level", "role", "frozen", "muted_until"])
    .select(
      sql<number>`(SELECT count(*) FROM messages WHERE user_id = users.id AND seen_at IS NULL)`.as(
        "unseen_messages",
      ),
    )
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
}

// Every person logged in, or who uses the site without opening it, an hour after their last
// refresh (design §6.1): a subscription or a follow sends them messages and a personal token lets
// their Agent in, so a ban or leaving the group must reach here. One at a time: mousehole's server
// is busy enough.
export async function refreshUsers() {
  const due = await db
    .selectFrom("users")
    .select(["id", "mousehole_token"])
    .where("synced_at", "<", new Date(Date.now() - REFRESH_AFTER_MS))
    .where("token_refused_at", "is", null)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("sessions")
            .select("sessions.id")
            .whereRef("sessions.user_id", "=", "users.id")
            .where("sessions.expires_at", ">", new Date()),
        ),
        eb.exists(
          eb
            .selectFrom("subscriptions")
            .select("subscriptions.user_id")
            .whereRef("subscriptions.user_id", "=", "users.id"),
        ),
        eb.exists(
          eb
            .selectFrom("follows")
            .select("follows.user_id")
            .whereRef("follows.user_id", "=", "users.id"),
        ),
        eb("users.id", "in", liveTokens().select("api_tokens.user_id")),
      ]),
    )
    .orderBy("synced_at")
    .execute();
  for (const user of due) {
    const profile = await fetchProfile(user.mousehole_token);
    // Only while the token asked about is still theirs: logging in meanwhile brought a new one.
    if (profile) {
      await db
        .updateTable("users")
        .set(fromProfile(profile, user.mousehole_token))
        .where("id", "=", user.id)
        .where("mousehole_token", "=", user.mousehole_token)
        .execute();
    } else {
      // Banned, or the access taken back: logged out, their tokens revoked (design §13), and no
      // messages until they log in again.
      await db.transaction().execute(async (trx) => {
        const refused = await trx
          .updateTable("users")
          .set({ token_refused_at: new Date() })
          .where("id", "=", user.id)
          .where("mousehole_token", "=", user.mousehole_token)
          .executeTakeFirst();
        if (refused.numUpdatedRows === 0n) return;
        await trx.deleteFrom("sessions").where("user_id", "=", user.id).execute();
        await trx
          .updateTable("api_tokens")
          .set({ revoked_at: new Date() })
          .where("user_id", "=", user.id)
          .where("revoked_at", "is", null)
          .execute();
      });
    }
  }
}

// An admin takes back someone's editing here (design §6.2); mousehole is left as it is.
export async function revokeEditing(trx: Transaction<DB>, userId: number) {
  const row = await trx
    .updateTable("users")
    .set({ edit_revoked_at: new Date() })
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "用户不存在");
}

// An admin gives it back. Edits reverted when it was taken stay reverted. No key changes, so the
// row is locked as an update of it would: FOR UPDATE would also hold off the audit log's reference
// to the person, and two admins whose editing was taken back, giving it back to each other at
// once, would deadlock.
export async function restoreEditing(trx: Transaction<DB>, userId: number) {
  const user = await trx
    .selectFrom("users")
    .select("edit_revoked_at")
    .where("id", "=", userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!user) throw new AppError(404, "not_found", "用户不存在");
  if (!user.edit_revoked_at) throw new AppError(409, "not_revoked", "该用户的修改权限没有被收回");
  await trx.updateTable("users").set({ edit_revoked_at: null }).where("id", "=", userId).execute();
}

// Those whose editing an admin has taken back, the latest first.
export async function listEditRevoked() {
  const rows = await db
    .selectFrom("users")
    .select(["id", "display_name", "avatar_url", "edit_revoked_at"])
    .where("edit_revoked_at", "is not", null)
    .orderBy("edit_revoked_at", "desc")
    .$narrowType<{ edit_revoked_at: Date }>()
    .execute();
  return rows.map(({ edit_revoked_at, ...user }) => ({
    ...user,
    revoked_at: unix(edit_revoked_at),
  }));
}

// Taken in an edit's transaction and held until it commits. An admin taking back this person's
// editing meanwhile waits for it, then reverts it with the rest of theirs; or the edit waits for
// the admin and is turned down. Either way none slips past.
export async function holdEditing(trx: Transaction<DB>, userId: number) {
  const user = await trx
    .selectFrom("users")
    .select("edit_revoked_at")
    .where("id", "=", userId)
    .forShare()
    .executeTakeFirstOrThrow();
  if (user.edit_revoked_at) throw editRevoked();
}

export async function clearExpiredSessions() {
  await db.deleteFrom("sessions").where("expires_at", "<", new Date()).execute();
}
