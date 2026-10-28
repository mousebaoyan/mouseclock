import { redirect } from "react-router";
import { apiContext, cookiesFrom } from "../api.server.ts";
import type { Route } from "./+types/logout.ts";

export async function action({ context }: Route.ActionArgs) {
  const res = await context.get(apiContext).auth.logout.$post();
  return redirect("/", { headers: cookiesFrom(res) });
}
