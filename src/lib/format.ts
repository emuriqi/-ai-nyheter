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
