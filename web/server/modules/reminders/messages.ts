import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db, pageOf } from "../../platform/db.ts";
import { unix } from "../../platform/http.ts";
import { mayEmail, queueEmails } from "./email.ts";
import type { MessageKind } from "./kinds.ts";

// Messages on the site (design §11.1). Other modules send them with sendMessages, in the
// transaction that causes them, so a message comes only when what it tells of has happened.

export type Message = {
  user_id: number;
  // One line each: what happened, then the details.
  title: string;
  body: string;
  // Where it takes the member: a path on this site, such as /programs/12.
  link: `/${string}`;
};

// Frozen accounts get none. Those who take this kind by email get one too.
export async function sendMessages(trx: Transaction<DB>, kind: MessageKind, messages: Message[]) {
  if (messages.length === 0) return;
  const users = await trx
    .selectFrom("users")
    .select(["id", "qq"])
    .where(
      "id",
      "in",
      messages.map((m) => m.user_id),
    )
    .where("frozen", "=", false)
    .execute();
  const members = new Set(users.map((user) => user.id));
  const mailable = new Set(users.filter(mayEmail).map((user) => user.id));
  const going = messages.filter((m) => members.has(m.user_id));
  if (going.length === 0) return;
  const written = await trx
    .insertInto("messages")
    .values(going.map((m) => ({ ...m, kind })))
    .returning(["id", "user_id", "title", "body", "link"])
    .execute();
  await queueEmails(
    trx,
    kind,
    written.filter((m) => mailable.has(m.user_id)),
  );
}

// Newest first, with whether each was seen before.
export async function listMessages(userId: number, paging: { page: number; per_page: number }) {
  const page = await pageOf(
    db
      .selectFrom("messages")
      .select(["id", "kind", "title", "body", "link", "created_at", "seen_at"])
      .where("user_id", "=", userId)
      .orderBy("id", "desc"),
    paging,
  );
  return {
    ...page,
    items: page.items.map(({ created_at, seen_at, ...message }) => ({
      ...message,
      created_at: unix(created_at),
      seen: seen_at !== null,
    })),
  };
}

// This message and the ones before it: those that came after the page opened stay unseen.
export async function markSeen(userId: number, upTo: number) {
  await db
    .updateTable("messages")
    .set({ seen_at: sql<Date>`now()` })
    .where("user_id", "=", userId)
    .where("id", "<=", upTo)
    .where("seen_at", "is", null)
    .execute();
}
