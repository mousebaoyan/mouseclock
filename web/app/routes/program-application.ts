import { data, replace } from "react-router";
import { ApplicationInput } from "../../server/modules/programs/schemas.ts";
import { formText } from "../admin.server.ts";
import { apiContext } from "../api.server.ts";
import { forgetTable } from "../table-cache.ts";
import type { Route } from "./+types/program-application.ts";

// Keeping one's record of applying to a program (design §9.4), from its page or 我的 · 报名. The
// page sends where to go after it: its own address, without the open form.
export async function action({ request, params, context }: Route.ActionArgs) {
  const api = context.get(apiContext).programs[":id"].application;
  const param = { id: params.id };
  const form = await request.formData();
  let res;
  if (formText(form, "intent") === "clear") {
    res = await api.$delete({ param });
  } else {
    const input = ApplicationInput.safeParse({
      stage: formText(form, "stage"),
      note: formText(form, "note"),
    });
    if (!input.success) return data({ error: input.error.issues[0].message }, 400);
    res = await api.$put({ param, json: input.data });
  }
  if (res.status !== 204) return data({ error: (await res.json()).error.message }, res.status);
  // Only a page of this site, never another site's address.
  const next = new URL(formText(form, "next"), request.url);
  return replace(
    next.origin === new URL(request.url).origin
      ? next.pathname + next.search
      : `/programs/${params.id}`,
  );
}

// The stage shows on the table's cards. Forgotten first: once kept, serverAction throws the
// redirect.
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  forgetTable();
  return serverAction();
}
