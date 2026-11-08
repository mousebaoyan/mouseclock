// Instants as Beijing time: the date and time, or the time of day alone for lists already
// grouped by day.

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function DateTime({ value }: { value: number }) {
  const date = new Date(value * 1000);
  return (
    <time dateTime={date.toISOString()} className="tabular-nums">
      {dateTime.format(date)}
    </time>
  );
}

export function ClockTime({ value }: { value: number }) {
  const date = new Date(value * 1000);
  return (
    <time dateTime={date.toISOString()} className="tabular-nums">
      {clock.format(date)}
    </time>
  );
}
