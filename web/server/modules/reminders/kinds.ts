// The kinds of message (design §11.1): each one's name, whether it goes by email until the owner
// says otherwise (§11.2), and why the member gets it, for the foot of the email. A feature that
// sends a new kind adds it here and to the table in the design.
export const MESSAGE_KINDS = {
  deadline_soon: { label: "快截止了", email: "default_on", why: "你订阅了这个项目" },
  deadline_changed: { label: "截止变了", email: "default_on", why: "你订阅了这个项目" },
  inclusion_result: {
    label: "求收录有结果",
    email: "default_on",
    why: "你提过或同求过这个学院的求收录",
  },
} as const satisfies Record<string, { label: string; email: EmailRule; why: string }>;

export type MessageKind = keyof typeof MESSAGE_KINDS;

export const EMAIL_RULES = ["default_on", "default_off", "never"] as const;
export type EmailRule = (typeof EMAIL_RULES)[number];

export function isKind(value: string): value is MessageKind {
  return Object.hasOwn(MESSAGE_KINDS, value);
}

export const KINDS = Object.keys(MESSAGE_KINDS).filter(isKind);
