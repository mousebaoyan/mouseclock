import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/college-follow.ts";

// Following a college from its page or 院校清单, which stays as it is (design §11.4).
export async function action({ request, params, context }: Route.ActionArgs) {
  const api = context.get(apiContext).colleges[":id"].follow;
  const param = { id: params.id };
  const res =
    request.method === "DELETE" ? await api.$delete({ param }) : await api.$put({ param });
  if (res.status === 204) return null;
  return data({ message: (await res.json()).error.message }, res.status);
}
