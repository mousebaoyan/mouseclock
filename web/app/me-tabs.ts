// The tabs of 我的 (design §10.2), in order; /me opens the first. A feature adds its tab here when
// it is done.
export const ME_TABS = [
  { to: "/me/subscriptions", label: "订阅" },
  { to: "/me/follows", label: "关注" },
  { to: "/me/applications", label: "报名" },
  { to: "/me/feedback", label: "反馈" },
  { to: "/me/agent", label: "Agent" },
  { to: "/me/email", label: "邮件提醒" },
] as const;
