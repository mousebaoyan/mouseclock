import { expect, test } from "vitest";
import { app } from "./app.ts";

test("unknown API paths answer in the error format of api.md §1", async () => {
  const res = await app.request("/api/v1/nothing-here");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: "接口不存在" } });
});

test("the health check reaches the database", async () => {
  const res = await app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
