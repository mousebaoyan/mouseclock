import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("colleges", "routes/colleges.tsx"),
  route("colleges/:id", "routes/college-detail.tsx"),
  route("programs/:id", "routes/program-detail.tsx"),
  route("programs/:id/subscription", "routes/program-subscription.ts"),
  route("snapshots/:id", "routes/snapshot.tsx"),
  route("review", "routes/review.tsx"),
  route("crawl", "routes/crawl.tsx"),
  route("edits", "routes/edits.tsx"),
  route("messages", "routes/messages.tsx"),
  route("me", "routes/me.tsx", [
    index("routes/me-index.ts"),
    route("subscriptions", "routes/me-subscriptions.tsx"),
    route("email", "routes/me-email.tsx"),
  ]),
  route("logout", "routes/logout.ts"),
  route("admin/colleges", "routes/admin-colleges.tsx"),
  route("admin/sources", "routes/admin-sources.tsx"),
  route("admin/users", "routes/admin-users.tsx"),
  route("admin/settings", "routes/admin-settings.tsx"),
] satisfies RouteConfig;
