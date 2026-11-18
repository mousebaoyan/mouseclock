import { setTimeout } from "node:timers/promises";
import { html } from "hono/html";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { log } from "../../platform/log.ts";
import { SITE_NAME } from "../../platform/site.ts";
import { recordAudit } from "../../platform/audit.ts";
import { isKind, KINDS, MESSAGE_KINDS, type EmailRule, type MessageKind } from "./kinds.ts";
import { deliver } from "./mailer.ts";

// Which messages also go by email, and sending them (design §11.2).

const SETTINGS_PATH = "/me/email";

// Who may get emails at all, when they are queued and again when they are sent. Everyone with a
// QQ number for now; if emails come to be only for sponsors, a mousehole level or a quota bought
// with 鼠币, that is decided here, and only for emails: messages on the site still come.
export function mayEmail<T extends { qq: number | null }>(user: T): user is T & { qq: number } {
  return user.qq !== null;
}

// The owner's rule for each kind, or the kind's default where there is none.
export async function emailRules() {
  const rows = await db
    .selectFrom("email_rules")
    .select(["kind", sql<EmailRule>`rule`.as("rule")])
    .execute();
  const set = new Map(rows.map((row) => [row.kind, row.rule]));
  return KINDS.map((kind) => ({ kind, rule: set.get(kind) ?? MESSAGE_KINDS[kind].email }));
}

async function ruleOf(kind: MessageKind, executor: Kysely<DB> = db) {
  const row = await executor
    .selectFrom("email_rules")
    .select(sql<EmailRule>`rule`.as("rule"))
    .where("kind", "=", kind)
    .executeTakeFirst();
  return row?.rule ?? MESSAGE_KINDS[kind].email;
}

export async function saveEmailRules(
  owner: { user_id: number; via: "web" },
  rules: Partial<Record<MessageKind, EmailRule>>,
) {
  const rows = Object.entries(rules).map(([kind, rule]) => ({ kind, rule }));
  if (rows.length === 0) return;
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("email_rules")
      .values(rows)
      .onConflict((oc) =>
        oc.column("kind").doUpdateSet((eb) => ({ rule: eb.ref("excluded.rule") })),
      )
      .execute();
    await recordAudit(trx, {
      user_id: owner.user_id,
      action: "update",
      target_type: "email_rules",
      target_id: null,
      detail: { via: owner.via, rules },
    });
  });
}

// A member's switch wins over the owner's default; "never" wins over both.
function emailOn(rule: EmailRule, enabled: boolean | undefined) {
  return rule !== "never" && (enabled ?? rule === "default_on");
}

// The kinds a member can turn on or off, which leaves out those the owner sends never.
export async function emailSettings(userId: number) {
  const [rules, mine, user] = await Promise.all([
    emailRules(),
    db
      .selectFrom("email_settings")
      .select(["kind", "enabled"])
      .where("user_id", "=", userId)
      .execute(),
    db.selectFrom("users").select("qq").where("id", "=", userId).executeTakeFirstOrThrow(),
  ]);
  const set = new Map(mine.map((row) => [row.kind, row.enabled]));
  return {
    receives: mayEmail(user),
    kinds: rules.flatMap(({ kind, rule }) => {
      if (rule === "never") return [];
      return [
        {
          kind,
          label: MESSAGE_KINDS[kind].label,
          enabled: emailOn(rule, set.get(kind)),
          default_enabled: rule === "default_on",
        },
      ];
    }),
  };
}

export async function saveEmailSettings(
  userId: number,
  settings: Partial<Record<MessageKind, boolean>>,
) {
  const rows = Object.entries(settings).map(([kind, enabled]) => ({
    user_id: userId,
    kind,
    enabled,
  }));
  if (rows.length === 0) return;
  await db
    .insertInto("email_settings")
    .values(rows)
    .onConflict((oc) =>
      oc
        .columns(["user_id", "kind"])
        .doUpdateSet((eb) => ({ enabled: eb.ref("excluded.enabled") })),
    )
    .execute();
}

async function wantsEmail(userId: number, kind: string) {
  if (!isKind(kind)) return false;
  const [rule, mine] = await Promise.all([
    ruleOf(kind),
    db
      .selectFrom("email_settings")
      .select("enabled")
      .where("user_id", "=", userId)
      .where("kind", "=", kind)
      .executeTakeFirst(),
  ]);
  return emailOn(rule, mine?.enabled);
}

type Written = { id: number; user_id: number; title: string; body: string; link: string };

// Emails for messages just written, to those who take this kind by email. Whether each still goes
// is asked again when it is sent.
export async function queueEmails(trx: Transaction<DB>, kind: MessageKind, messages: Written[]) {
  if (messages.length === 0) return;
  const rule = await ruleOf(kind, trx);
  const mine = new Map(
    (
      await trx
        .selectFrom("email_settings")
        .select(["user_id", "enabled"])
        .where("kind", "=", kind)
        .where(
          "user_id",
          "in",
          messages.map((m) => m.user_id),
        )
        .execute()
    ).map((row) => [row.user_id, row.enabled]),
  );
  const going = messages.filter((m) => emailOn(rule, mine.get(m.user_id)));
  if (going.length === 0) return;
  await trx
    .insertInto("emails")
    .values(
      await Promise.all(
        going.map(async (m) => ({
          user_id: m.user_id,
          message_id: m.id,
          subject: m.title,
          body: plainText(kind, m),
          html: await page(kind, m),
        })),
      ),
    )
    .execute();
}

function plainText(kind: MessageKind, { title, body, link }: Written) {
  return [
    title,
    "",
    body,
    "",
    `${env.PUBLIC_URL}${link}`,
    "",
    "——",
    `${MESSAGE_KINDS[kind].why}。不想收这类邮件，可以在「我的 · 邮件提醒」里关掉：${env.PUBLIC_URL}${SETTINGS_PATH}`,
  ].join("\n");
}

// The message on a card, then why it came. Tables and inline styles only, the one thing mail apps
// agree on, and no images. hono/html escapes what goes in.
async function page(kind: MessageKind, { title, body, link }: Written) {
  const settings = `${env.PUBLIC_URL}${SETTINGS_PATH}`;
  const rendered = await html`<!doctype html>
    <html lang="zh-CN">
      <body style="margin:0;background:#f4f5f7;">
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="background:#f4f5f7;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;"
        >
          <tr>
            <td style="padding:24px 12px;">
              <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px;"
              >
                <tr>
                  <td style="padding:24px 28px 0;font-size:13px;color:#6b7280;">${SITE_NAME}</td>
                </tr>
                <tr>
                  <td style="padding:12px 28px 28px;font-size:15px;line-height:1.8;color:#1f2933;">
                    <p style="margin:0;font-size:17px;font-weight:600;">${title}</p>
                    <p style="margin:8px 0 0;">${body}</p>
                    <p style="margin:24px 0 0;">
                      <a
                        href="${env.PUBLIC_URL}${link}"
                        style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:9px 20px;border-radius:8px;"
                        >在${SITE_NAME}查看</a
                      >
                    </p>
                  </td>
                </tr>
              </table>
              <p
                style="max-width:560px;margin:12px auto 0;font-size:12px;line-height:1.8;color:#6b7280;text-align:center;"
              >
                ${MESSAGE_KINDS[kind].why}。不想收这类邮件，可以在<a
                  href="${settings}"
                  style="color:#6b7280;"
                  >「我的 · 邮件提醒」</a
                >里关掉。
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>`;
  // A run of whitespace shows as one space, and the indentation would be a third of each email.
  return rendered.toString().replace(/[ \t\r\n]+/g, " ");
}

// A failed email waits 5, 10, 20 and 40 minutes before trying again, then is dropped, as is one
// still unsent after a day: a reminder that late is no use.
const RETRY_MINUTES = 5;
const MAX_ATTEMPTS = 5;

// Every minute: the due emails, oldest first, a second or two apart so a batch doesn't leave all at
// once, until none is left or no mailbox can send.
export async function sendEmails() {
  const stale = await db
    .updateTable("emails")
    .set({ dropped_at: sql<Date>`now()` })
    .where("sent_at", "is", null)
    .where("dropped_at", "is", null)
    .where("created_at", "<", sql<Date>`now() - interval '1 day'`)
    .executeTakeFirst();
  if (stale.numUpdatedRows > 0n) {
    log("warn", "Dropped emails unsent for a day", { count: Number(stale.numUpdatedRows) });
  }
  let delivered = false;
  for (;;) {
    // A second or two after the last one, so a batch doesn't leave all at once. What is checked
    // below is as things are after the wait.
    if (delivered) await setTimeout(1000 + Math.random() * 1000);
    delivered = false;
    const email = await db
      .selectFrom("emails as e")
      .innerJoin("messages as m", "m.id", "e.message_id")
      .innerJoin("users as u", "u.id", "e.user_id")
      .select(["e.id", "e.user_id", "e.subject", "e.body", "e.html", "e.attempts", "m.kind"])
      .select(["u.qq", "u.frozen"])
      .where("e.sent_at", "is", null)
      .where("e.dropped_at", "is", null)
      .where("e.next_at", "<=", sql<Date>`now()`)
      .orderBy("e.id")
      .limit(1)
      .executeTakeFirst();
    if (!email) return;
    // As things are now: the member may have turned this kind off, or left the group, since.
    if (email.frozen || !mayEmail(email) || !(await wantsEmail(email.user_id, email.kind))) {
      await settle(email.id, "dropped_at");
      continue;
    }
    const outcome = await deliver({
      to: `${email.qq}@qq.com`,
      subject: email.subject,
      text: email.body,
      html: email.html,
    });
    delivered = true;
    if (outcome === "resting") return;
    const attempts = email.attempts + 1;
    if (outcome === "failed" && attempts < MAX_ATTEMPTS) {
      const minutes = RETRY_MINUTES * 2 ** (attempts - 1);
      await db
        .updateTable("emails")
        .set({ attempts, next_at: sql<Date>`now() + make_interval(mins => ${minutes})` })
        .where("id", "=", email.id)
        .execute();
      continue;
    }
    if (outcome !== "sent") log("warn", "Dropped email", { id: email.id, outcome });
    await settle(email.id, outcome === "sent" ? "sent_at" : "dropped_at");
  }
}

async function settle(id: number, done: "sent_at" | "dropped_at") {
  const now = sql<Date>`now()`;
  await db
    .updateTable("emails")
    .set(done === "sent_at" ? { sent_at: now } : { dropped_at: now })
    .where("id", "=", id)
    .execute();
}

const TESTED = "这是一封测试邮件，收到就说明这个发信邮箱能正常发信。";
export const TEST_EMAIL = {
  subject: `${SITE_NAME}测试邮件`,
  text: TESTED,
  html: `<p>${TESTED}</p>`,
};
