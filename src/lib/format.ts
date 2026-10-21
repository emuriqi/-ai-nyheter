const dateTimeFormat = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Oslo",
});

const dateFormat = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeZone: "Europe/Oslo",
});

/** «12. okt. 2026, 10:15» i norsk tid. */
export function formatDateTime(date: Date | null | undefined): string {
  return date ? dateTimeFormat.format(date) : "–";
}

/** «12. okt. 2026» i norsk tid. */
export function formatDate(date: Date | null | undefined): string {
  return date ? dateFormat.format(date) : "–";
}

const partsFormat = new Intl.DateTimeFormat("nb-NO", {
  timeZone: "Europe/Oslo",
  weekday: "long",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const MONTH_NAMES = [
  "januar",
  "februar",
  "mars",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "desember",
];

export type OsloTime = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

/** Dato og klokkeslett i norsk tid, som tall. */
export function osloTime(date: Date): OsloTime {
  const parts = Object.fromEntries(partsFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

/** «onsdag 7. oktober 2026 kl. 12.14» i norsk tid. */
export function formatLongDateTime(date: Date): string {
  const t = osloTime(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.weekday} ${t.day}. ${MONTH_NAMES[t.month - 1]} ${t.year} kl. ${pad(t.hour)}.${pad(t.minute)}`;
}
