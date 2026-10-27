import { log } from "./log.ts";

// Jobs that run every so often inside this one process. A failed run is logged and the next one
// tries again. A run still going when the next is due skips that one.
export function every(ms: number, name: string, job: () => Promise<unknown>) {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((error: unknown) => log("error", `${name} failed`, { error }))
      .finally(() => {
        running = false;
      });
  }, ms).unref();
}
