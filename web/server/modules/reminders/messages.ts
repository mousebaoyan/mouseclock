import type { Transaction } from "kysely";
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
  // Pages elsewhere the email adds, such as the notice and where to apply.
  links?: { label: string; url: string }[];
};

// Frozen accounts get none, nor those mousehole no longer lets in. Those who take this kind by
// email get one too. Returns who got theirs.
export async function sendMessages(trx: Transaction<DB>, kind: MessageKind, messages: Message[]) {
  if (messages.length === 0) return new Set<number>();
  const users = await trx
    .selectFrom("users")
    .select(["id", "qq"])
    .where(
      "id",
      "in",
      messages.map((m) => m.user_id),
    )
    .where("frozen", "=", false)
    .where("token_refused_at", "is", null)
    .execute();
  const members = new Set(users.map((user) => user.id));
  const mailable = new Set(users.filter(mayEmail).map((user) => user.id));
  const going = messages.filter((m) => members.has(m.user_id));
  if (going.length === 0) return members;
  // One at a time, so each email knows its message: RETURNING doesn't promise the order of VALUES.
  const written = [];
  for (const m of going) {
    const { id } = await trx
      .insertInto("messages")
      .values({ user_id: m.user_id, kind, title: m.title, body: m.body, link: m.link })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (mailable.has(m.user_id)) written.push({ ...m, id });
  }
  await queueEmails(trx, kind, written);
  return members;
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
    .set({ seen_at: new Date() })
    .where("user_id", "=", userId)
    .where("id", "<=", upTo)
    .where("seen_at", "is", null)
    .execute();
}
