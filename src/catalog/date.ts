// Внутренний помощник `/catalog`: из подмодуля не экспортируется.
import { isCalendarDateTime } from "../iso-date.js";

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 с часовым поясом (`Z` или `±hh:mm`); компоненты — по календарю (К20 п. 1). */
export function isIsoDateTime(s: string): boolean {
  return ISO_DATE_TIME.test(s) && isCalendarDateTime(s);
}
