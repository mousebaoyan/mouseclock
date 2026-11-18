import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  Int,
  named,
  Page,
  PageParams,
  UnixSeconds,
} from "../../platform/http.ts";
import {
  emailRules,
  emailSettings,
  saveEmailRules,
  saveEmailSettings,
  TEST_EMAIL,
} from "./email.ts";
import { EMAIL_RULES, KINDS, MESSAGE_KINDS } from "./kinds.ts";
import { listMailAccounts, saveMailAccounts, testMailAccounts } from "./mailer.ts";
import { listMessages, markSeen } from "./messages.ts";

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const Kind = z.enum(KINDS);
const Rule = z.enum(EMAIL_RULES).openapi({ description: "默认发、默认不发、不发" });

const Message = z
  .object({
    id: Int,
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    link: z.string().openapi({ description: "站内的路径，比如 /programs/12" }),
    created_at: UnixSeconds,
    seen: z.boolean().openapi({ description: "这次打开之前看过没有；没看过的标「新」" }),
  })
  .openapi("Message");

const EmailSettings = z
  .object({
    receives: z.boolean().openapi({ description: "能不能收邮件：没有 QQ 号的收不到" }),
    kinds: z.array(
      z.object({
        kind: Kind,
        label: z.string(),
        enabled: z.boolean(),
        default_enabled: z.boolean().openapi({ description: "站长的默认" }),
      }),
    ),
  })
  .openapi("EmailSettings");

const MailAccount = z.object({
  host: z.string(named("SMTP 服务器")).trim().min(1).max(200),
  port: z.number(named("端口")).int().min(1).max(65535),
  username: z.string(named("邮箱")).trim().min(1).max(200),
});

const signedIn = {
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结"),
};

const ownerOnly = {
  401: errorResponse("没有登录"),
  403: errorResponse("只有站长能操作"),
};

export const remindersRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/messages",
      summary: "自己的消息",
      description: "最新的在前，分页（总体设计 §11.1）。",
      request: { query: PageParams },
      responses: {
        200: { description: "消息", content: json(Page(Message)) },
        400: errorResponse("分页参数有误"),
        ...signedIn,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      return c.json(await listMessages(id, c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/messages/seen",
      summary: "标成看过了",
      description:
        "这一条和更早的标成看过了。消息页打开后，用页上最新的那条调，之后才到的不受影响。",
      request: {
        body: { required: true, content: json(z.strictObject({ up_to: Int })) },
      },
      responses: {
        204: { description: "已标记" },
        400: errorResponse("请求格式有误"),
        ...signedIn,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      await markSeen(id, c.req.valid("json").up_to);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/email-settings",
      summary: "邮件提醒",
      description:
        "每类消息发不发邮件；站长定成不发的不列，没动过的跟着站长的默认（总体设计 §11.2）。",
      responses: {
        200: { description: "各类的开关", content: json(EmailSettings) },
        ...signedIn,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      return c.json(await emailSettings(id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/me/email-settings",
      summary: "改邮件提醒",
      description: "只改给出的几类；改过的从此按自己的，不再跟着站长的默认。",
      request: {
        body: { required: true, content: json(z.partialRecord(Kind, z.boolean())) },
      },
      responses: {
        200: { description: "改后的开关", content: json(EmailSettings) },
        400: errorResponse("请求格式有误"),
        ...signedIn,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      await saveEmailSettings(id, c.req.valid("json"));
      return c.json(await emailSettings(id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/email-rules",
      summary: "邮件规则",
      description: "每类消息的邮件规则；站长没设过的是这一类的默认。",
      responses: {
        200: {
          description: "各类的规则",
          content: json(z.array(z.object({ kind: Kind, label: z.string(), rule: Rule }))),
        },
        ...ownerOnly,
      },
    }),
    async (c) => {
      authorize(c, "owner");
      const rules = await emailRules();
      return c.json(
        rules.map(({ kind, rule }) => ({
          kind,
          label: MESSAGE_KINDS[kind].label,
          rule,
        })),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/admin/email-rules",
      summary: "设定邮件规则",
      description: "只改给出的几类，记进操作日志。",
      request: {
        body: { required: true, content: json(z.partialRecord(Kind, Rule)) },
      },
      responses: {
        204: { description: "已保存" },
        400: errorResponse("请求格式有误"),
        ...ownerOnly,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "owner");
      await saveEmailRules({ user_id: id, via: "web" }, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/mail-accounts",
      summary: "发信邮箱",
      description: "按使用的顺序；密码不返回。",
      responses: {
        200: { description: "发信邮箱", content: json(z.array(MailAccount)) },
        ...ownerOnly,
      },
    }),
    async (c) => {
      authorize(c, "owner");
      return c.json(await listMailAccounts(), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/admin/mail-accounts",
      summary: "保存发信邮箱",
      description:
        "按顺序整个替换。没填密码的沿用这个邮箱原来的密码，新邮箱必须填。记进操作日志，密码不记。",
      request: {
        body: {
          required: true,
          content: json(
            z.strictObject({
              accounts: z
                .array(
                  MailAccount.extend({
                    password: z.string(named("密码")).min(1).max(200).optional(),
                  }),
                )
                .max(10)
                .refine(
                  (accounts) => new Set(accounts.map((a) => a.username)).size === accounts.length,
                  "同一个邮箱只能填一次",
                ),
            }),
          ),
        },
      },
      responses: {
        204: { description: "已保存" },
        400: errorResponse("请求格式有误，或新邮箱没填密码"),
        ...ownerOnly,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "owner");
      await saveMailAccounts({ user_id: id, via: "web" }, c.req.valid("json").accounts);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/mail-accounts/test",
      summary: "试发邮件",
      description: "每个发信邮箱各给 `QQ号@qq.com` 发一封，返回各自成没成。只发给站长自己的邮箱。",
      request: {
        body: {
          required: true,
          content: json(z.strictObject({ qq: z.string(named("QQ 号")).regex(/^[1-9]\d{4,11}$/) })),
        },
      },
      responses: {
        200: {
          description: "各个邮箱的结果",
          content: json(
            z.array(
              z.object({
                username: z.string(),
                error: z.string().nullable().openapi({ description: "为空是发出去了" }),
              }),
            ),
          ),
        },
        400: errorResponse("QQ 号的格式不对"),
        ...ownerOnly,
        409: errorResponse("还没有配置发信邮箱"),
      },
    }),
    async (c) => {
      authorize(c, "owner");
      return c.json(await testMailAccounts(`${c.req.valid("json").qq}@qq.com`, TEST_EMAIL), 200);
    },
  );
