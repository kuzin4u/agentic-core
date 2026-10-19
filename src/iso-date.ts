// Внутренний помощник `/catalog` и `/diag` (К20 п. 1): ни из одного входа не экспортируется.

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const leap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Компоненты строки, уже прошедшей шаблон формы, — по календарю, без нормализации `Date.parse`:
 *  месяц 01…12, день по месяцу и високосному году, час 00…23, минуты и секунды 00…59 (без `:60`),
 *  пояс `Z` или `±HH:MM` не больше 14:00. Доли секунды не проверяются. */
export function isCalendarDateTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12) return false;
  const last = mo === 2 && leap(y) ? 29 : DAYS[mo - 1]!;
  if (d < 1 || d > last || h > 23 || mi > 59) return false;
  if (m[6] !== undefined && Number(m[6]) > 59) return false;
  if (m[7] !== undefined) {
    const oh = Number(m[8]), om = Number(m[9]);
    if (om > 59 || oh * 60 + om > 14 * 60) return false;
  }
  return true;
}
