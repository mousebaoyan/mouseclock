import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Actor } from "../../platform/access.ts";
import { createTransport } from "nodemailer";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { log } from "../../platform/log.ts";
import { SITE_NAME } from "../../platform/site.ts";
import { recordAudit } from "../../platform/audit.ts";

// The mailboxes the owner set up (design §11.2), and the one place mail leaves through. As in
// mousehole: tried in order, and one that fails rests a while so the next takes over. A QQ
// mailbox that sent too much refuses for minutes up to the rest of the day, and trying again too
// soon may make that longer, so each failure in a row doubles the rest.

export type MailAccount = { host: string; port: number; username: string; password: string };
export type Mail = { to: string; subject: string; text: string; html: string };

const FIRST_REST_MS = 10 * 60_000;
const MAX_REST_MS = 8 * 60 * 60_000;
const resting = new Map<string, { until: number; failures: number }>();

// AES-256-GCM, stored as base64 of the IV, the auth tag and the ciphertext.
function encrypt(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", env.APP_SECRET, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decrypt(stored: string) {
  const raw = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", env.APP_SECRET, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// What the settings page shows: no passwords, so none is decrypted for it either.
export async function listMailAccounts() {
  return db
    .selectFrom("mail_accounts")
    .select(["host", "port", "username"])
    .orderBy("sort")
    .execute();
}

async function mailAccounts(): Promise<MailAccount[]> {
  const rows = await db
    .selectFrom("mail_accounts")
    .select(["host", "port", "username", "password"])
    .orderBy("sort")
    .execute();
  return rows.map((row) => ({ ...row, password: decrypt(row.password) }));
}

// The whole list, in order. One given without a password keeps the one it had: pages never get
// the passwords back to send them again.
export async function saveMailAccounts(
  owner: Actor,
  accounts: (Omit<MailAccount, "password"> & { password?: string })[],
) {
  await db.transaction().execute(async (trx) => {
    const kept = new Map(
      (
        await trx.selectFrom("mail_accounts").select(["username", "password"]).forUpdate().execute()
      ).map((row) => [row.username, row.password]),
    );
    const rows = accounts.map(({ password, ...account }, sort) => {
      const stored = password === undefined ? kept.get(account.username) : encrypt(password);
      if (stored === undefined) {
        throw new AppError(400, "password_required", `请填写 ${account.username} 的密码`);
      }
      return { ...account, sort, password: stored };
    });
    await trx.deleteFrom("mail_accounts").execute();
    if (rows.length > 0) await trx.insertInto("mail_accounts").values(rows).execute();
    await recordAudit(trx, {
      user_id: owner.user_id,
      action: "update",
      target_type: "mail_accounts",
      target_id: null,
      detail: {
        via: owner.via,
        accounts: accounts.map(({ host, port, username }) => ({ host, port, username })),
      },
    });
  });
  // Changed mailboxes, or changed passwords, are worth trying straight away.
  resting.clear();
}

function send(account: MailAccount, { to, subject, text, html }: Mail) {
  return createTransport({
    host: account.host,
    port: account.port,
    // 465 speaks TLS from the start; the others must upgrade with STARTTLS before the password
    // goes, or not send at all.
    secure: account.port === 465,
    requireTLS: true,
    auth: { user: account.username, pass: account.password },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  }).sendMail({ from: { name: SITE_NAME, address: account.username }, to, subject, text, html });
}

// The server turned the address down, rather than this mailbox failing to send.
function refused(error: unknown) {
  return (
    error instanceof Error &&
    "command" in error &&
    error.command === "RCPT TO" &&
    "responseCode" in error &&
    Number(error.responseCode) >= 500
  );
}

// The kind of failure, without the server's reply, which may quote the address (development.md §4).
function failureOf(error: unknown) {
  if (!(error instanceof Error)) return { code: "unknown" };
  return {
    code: "code" in error ? String(error.code) : error.name,
    command: "command" in error ? String(error.command) : undefined,
    status: "responseCode" in error ? Number(error.responseCode) : undefined,
  };
}

// "refused" when every mailbox turned the address down, so sending again won't help; while one
// resting hasn't tried yet, it is only "failed". "resting" when no mailbox could try.
export async function deliver(mail: Mail) {
  const accounts = await mailAccounts();
  let tried = 0;
  let refusals = 0;
  for (const account of accounts) {
    const rest = resting.get(account.username);
    if (rest && rest.until > Date.now()) continue;
    tried += 1;
    try {
      await send(account, mail);
      resting.delete(account.username);
      return "sent";
    } catch (error) {
      log("warn", "Sending mail failed", { account: account.username, ...failureOf(error) });
      // A refused address says nothing against the mailbox, which goes on sending to others.
      if (refused(error)) {
        refusals += 1;
        continue;
      }
      const failures = (rest?.failures ?? 0) + 1;
      const ms = Math.min(FIRST_REST_MS * 2 ** (failures - 1), MAX_REST_MS);
      resting.set(account.username, { until: Date.now() + ms, failures });
    }
  }
  if (tried === 0) return "resting";
  return refusals === accounts.length ? "refused" : "failed";
}

// One email from each mailbox to the owner's own address, resting or not; one that sends is no
// longer resting.
export async function testMailAccounts(to: string, mail: Omit<Mail, "to">) {
  const accounts = await mailAccounts();
  if (accounts.length === 0) {
    throw new AppError(409, "email_not_configured", "还没有配置发信邮箱");
  }
  const results = [];
  for (const account of accounts) {
    try {
      await send(account, { ...mail, to });
      resting.delete(account.username);
      results.push({ username: account.username, error: null });
    } catch (error) {
      results.push({
        username: account.username,
        error: error instanceof Error ? error.message : "发送失败",
      });
    }
  }
  return results;
}
