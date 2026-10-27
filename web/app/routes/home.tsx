import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">{SITE_NAME}</h1>
      <p className="mt-2 text-neutral-500">{SITE_DESCRIPTION}</p>
    </main>
  );
}
