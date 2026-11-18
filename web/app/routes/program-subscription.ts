import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import { forgetTable } from "../table-cache.ts";
import type { Route } from "./+types/program-subscription.ts";

// Subscribing on a card or a program's page, which stays as it is (design §11.3).
export async function action({ request, params, context }: Route.ActionArgs) {
  const api = context.get(apiContext).programs[":id"].subscription;
  const param = { id: params.id };
  const res =
    request.method === "DELETE" ? await api.$delete({ param }) : await api.$put({ param });
  if (res.status === 204) return null;
  const { error } = await res.json();
  return data({ message: error.message, full: error.code === "subscription_limit" }, res.status);
}

// The counts on the table's cards change with it.
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  const result = await serverAction();
  forgetTable();
  return result;
}
