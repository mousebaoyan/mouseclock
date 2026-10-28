import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("logout", "routes/logout.ts"),
  route("admin/colleges", "routes/admin-colleges.tsx"),
  route("admin/sources", "routes/admin-sources.tsx"),
] satisfies RouteConfig;
