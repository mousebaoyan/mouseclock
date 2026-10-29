import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("colleges", "routes/colleges.tsx"),
  route("colleges/:id", "routes/college-detail.tsx"),
  route("logout", "routes/logout.ts"),
  route("admin/colleges", "routes/admin-colleges.tsx"),
  route("admin/sources", "routes/admin-sources.tsx"),
] satisfies RouteConfig;
