// Внутренний помощник `/catalog`: из подмодуля не экспортируется.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 с часовым поясом (`Z` или `±hh:mm`). */
export function isIsoDateTime(s: string): boolean {
  return ISO_DATE_TIME.test(s) && Number.isFinite(Date.parse(s));
}
