import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-3 py-6 sm:px-5">
      <h1 className="text-2xl font-semibold">{SITE_NAME}</h1>
      <p className="mt-2 text-muted-foreground">{SITE_DESCRIPTION}</p>
    </main>
  );
}
