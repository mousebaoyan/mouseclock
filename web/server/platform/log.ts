// One JSON object per line on stdout, so `docker logs` output can be filtered with jq.
export function log(level: "info" | "warn" | "error", msg: string, fields: object = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }, serialize));
}

function serialize(_key: string, value: unknown) {
  return value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
    : value;
}
