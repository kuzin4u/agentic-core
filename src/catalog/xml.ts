/** Разборщик подмножества XML для фидов продавца (К14 п. 5). Внутренний: из `/catalog` не экспортируется.
 *  Без исполнения DTD: короткий DOCTYPE пропускается, внутреннее подмножество — отказ; сущности — только пять
 *  предопределённых и числовые. Один проход без рекурсии и без регулярных выражений с возвратами — время линейно. */

/** Элемент: имя, атрибуты (без прототипа — имена от продавца), дети — элементы и текст (соседний текст слит). */
export interface XmlElement { name: string; attrs: Record<string, string>; children: XmlNode[]; }
export type XmlNode = XmlElement | string;

export type XmlErrorCode =
  | "XML_SYNTAX"   // вход не XML или вне подмножества
  | "XML_ENTITY"   // сущность не из пяти предопределённых и не допустимая числовая
  | "XML_DOCTYPE"  // DOCTYPE с внутренним подмножеством, иной формы, длиннее 1 КиБ, повторный или после корня
  | "XML_ENCODING" // кодировка не UTF-8 и не windows-1251 либо неверная последовательность байт
  | "XML_LIMIT";   // больше maxBytes, глубже maxDepth или больше 256 атрибутов у элемента

/** `offset` — смещение в символах декодированного входа (для ошибки кодировки и размера — 0). */
export type XmlResult = { ok: true; root: XmlElement } | { ok: false; code: XmlErrorCode; offset: number };

export interface XmlLimits { maxBytes?: number; maxDepth?: number; }

const MAX_BYTES = 64 * 1024 * 1024, MAX_DEPTH = 64, MAX_ATTRS = 256, MAX_DOCTYPE = 1024;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

class Fail { constructor(readonly code: XmlErrorCode, readonly offset: number) {} }

/** Разбор документа. Исключений на данных продавца нет; `RangeError` — только на неверных пределах вызова. */
export function parseXml(input: string | Uint8Array, limits: XmlLimits = {}): XmlResult {
  const maxBytes = limit(limits.maxBytes, MAX_BYTES, "maxBytes"), maxDepth = limit(limits.maxDepth, MAX_DEPTH, "maxDepth");
  try {
    const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
    if (bytes > maxBytes) throw new Fail("XML_LIMIT", 0);
    return { ok: true, root: new Parser(typeof input === "string" ? input : decode(input), maxDepth).document() };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, offset: e.offset };
    throw e;
  }
}

function limit(v: number | undefined, def: number, name: string): number {
  if (v === undefined) return def;
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(name);
  return v;
}

/** Байты → строка по объявлению: UTF-8 (по умолчанию и с BOM) или windows-1251; `fatal` — неверный байт не заменяется. */
function decode(b: Uint8Array): string {
  let enc = "utf-8";
  if (b[0] === 0xfe || b[0] === 0xff || b[0] === 0) throw new Fail("XML_ENCODING", 0); // UTF-16, UTF-32
  if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) {
    const head = new TextDecoder("latin1").decode(b.subarray(0, 256));
    if (head.startsWith("<?xml")) {
      const end = head.indexOf("?>");
      const decl = end < 0 ? head : head.slice(0, end);
      const at = decl.indexOf("encoding");
      if (at >= 0) {
        const q = decl.slice(at + 8).trimStart();
        if (q[0] !== "=") throw new Fail("XML_SYNTAX", at);
        const v = q.slice(1).trimStart(), close = v.indexOf(v[0] ?? "", 1);
        if ((v[0] !== "\"" && v[0] !== "'") || close < 0) throw new Fail("XML_SYNTAX", at);
        enc = v.slice(1, close).toLowerCase();
      }
    }
  }
  if (enc !== "utf-8" && enc !== "windows-1251") throw new Fail("XML_ENCODING", 0);
  try { return new TextDecoder(enc, { fatal: true }).decode(b); } catch { throw new Fail("XML_ENCODING", 0); }
}

class Parser {
  private i = 0;
  constructor(private readonly s: string, private readonly maxDepth: number) {
    if (s.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  document(): XmlElement {
    const { s } = this;
    let root: XmlElement | undefined, doctype = false;
    if (s.startsWith("<?xml", this.i) && isSpace(s.charCodeAt(this.i + 5))) this.skip("?>", "XML_SYNTAX");
    for (;;) {
      this.space();
      if (this.i >= s.length) break;
      if (s.startsWith("<!--", this.i)) this.skip("-->", "XML_SYNTAX");
      else if (s.startsWith("<?", this.i)) this.pi();
      else if (s.startsWith("<!DOCTYPE", this.i)) {
        if (doctype || root) throw new Fail("XML_DOCTYPE", this.i);
        this.doctype(); doctype = true;
      } else if (!root && s[this.i] === "<") root = this.element();
      else throw new Fail("XML_SYNTAX", this.i);
    }
    if (!root) throw new Fail("XML_SYNTAX", this.i);
    return root;
  }

  /** Короткая форма: `<!DOCTYPE имя>`, `… SYSTEM "…">`, `… PUBLIC "…" "…">`; `[` вне кавычек — отказ. Не длиннее 1 КиБ. */
  private doctype(): void {
    const { s } = this, start = this.i, stop = Math.min(s.length, start + MAX_DOCTYPE);
    let j = start + 9, quote = "";
    for (; j < stop; j++) {
      const c = s[j];
      if (quote) { if (c === quote) quote = ""; }
      else if (c === "\"" || c === "'") quote = c;
      else if (c === "[") throw new Fail("XML_DOCTYPE", j);
      else if (c === ">") break;
    }
    if (j >= stop) throw new Fail("XML_DOCTYPE", start);
    // длина ≤ 1 КиБ — выражение без вложенных повторов, возвратов на таком входе мало
    if (!/^<!DOCTYPE\s+[A-Za-z_:][\w.:-]*(?:\s+(?:SYSTEM\s+(?:"[^"]*"|'[^']*')|PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')))?\s*>$/
      .test(s.slice(start, j + 1))) throw new Fail("XML_DOCTYPE", start);
    this.i = j + 1;
  }

  /** Элементы — стеком, без рекурсии: глубина вложенности не расходует стек вызовов. */
  private element(): XmlElement {
    const { s } = this, stack: XmlElement[] = [];
    let root: XmlElement | undefined;
    do {
      const at = this.i;
      if (s.startsWith("</", at)) {
        this.i += 2;
        const name = this.name(), top = stack.pop();
        if (name !== top?.name) throw new Fail("XML_SYNTAX", at);
        this.space();
        this.expect(">");
      } else if (s.startsWith("<!--", at)) this.skip("-->", "XML_SYNTAX");
      else if (s.startsWith("<![CDATA[", at)) {
        if (!stack.length) throw new Fail("XML_SYNTAX", at);
        const end = s.indexOf("]]>", at + 9);
        if (end < 0) throw new Fail("XML_SYNTAX", at);
        text(stack[stack.length - 1]!, s.slice(at + 9, end));
        this.i = end + 3;
      } else if (s.startsWith("<?", at)) this.pi();
      else if (s[at] === "<") {
        this.i++;
        const el: XmlElement = { name: this.name(), attrs: Object.create(null) as Record<string, string>, children: [] };
        const closed = this.attributes(el);
        if (stack.length) stack[stack.length - 1]!.children.push(el); else root = el;
        if (!closed) {
          if (stack.length >= this.maxDepth) throw new Fail("XML_LIMIT", at);
          stack.push(el);
        }
      } else {
        if (at >= s.length) throw new Fail("XML_SYNTAX", at);
        const end = s.indexOf("<", at), stop = end < 0 ? s.length : end;
        text(stack[stack.length - 1]!, this.chars(at, stop, false));
        this.i = stop;
      }
    } while (stack.length);
    return root!;
  }

  /** Атрибуты до `>` или `/>`; `true` — элемент закрыт сразу. */
  private attributes(el: XmlElement): boolean {
    const { s } = this;
    let n = 0;
    for (;;) {
      const sp = this.space();
      if (s.startsWith("/>", this.i)) { this.i += 2; return true; }
      if (s[this.i] === ">") { this.i++; return false; }
      if (!sp) throw new Fail("XML_SYNTAX", this.i);
      const at = this.i, name = this.name();
      if (++n > MAX_ATTRS) throw new Fail("XML_LIMIT", at);
      if (name in el.attrs) throw new Fail("XML_SYNTAX", at);
      this.space();
      this.expect("=");
      this.space();
      const q = s[this.i];
      if (q !== "\"" && q !== "'") throw new Fail("XML_SYNTAX", this.i);
      const end = s.indexOf(q, this.i + 1);
      if (end < 0) throw new Fail("XML_SYNTAX", this.i);
      const lt = s.slice(this.i + 1, end).indexOf("<");
      if (lt >= 0) throw new Fail("XML_SYNTAX", this.i + 1 + lt);
      el.attrs[name] = this.chars(this.i + 1, end, true);
      this.i = end + 1;
    }
  }

  /** Текст с заменой ссылок на сущности. Переводы строки — только в буквальном тексте, не в ссылках:
   *  `\r\n` и `\r` — `\n` (XML 1.0, 2.11); в значении атрибута перевод строки и табуляция — пробел (3.3.3). */
  private chars(from: number, to: number, attr: boolean): string {
    // поиск `&` — только в своём отрезке: indexOf по всему входу дал бы квадратичное время на многих отрезках
    const t = this.s.slice(from, to);
    const norm = (x: string) => attr ? x.replace(/\r\n?|[\n\t]/g, " ") : x.replace(/\r\n?/g, "\n");
    let out = "", i = 0;
    for (;;) {
      const amp = t.indexOf("&", i);
      if (amp < 0) { out += norm(t.slice(i)); break; }
      out += norm(t.slice(i, amp));
      let semi = amp + 1;
      while (semi < t.length && semi - amp <= 10 && t[semi] !== ";") semi++;
      if (t[semi] !== ";") throw new Fail("XML_ENTITY", from + amp);
      out += entity(t.slice(amp + 1, semi), from + amp);
      i = semi + 1;
    }
    return out;
  }

  private name(): string {
    const { s } = this, start = this.i;
    while (this.i < s.length && isNameChar(s.charCodeAt(this.i), this.i === start)) this.i++;
    if (this.i === start) throw new Fail("XML_SYNTAX", start);
    return s.slice(start, this.i);
  }

  /** Инструкция обработки пропускается; `<?xml` вне начала документа — ошибка. */
  private pi(): void {
    const t = this.s.slice(this.i + 2, this.i + 6);
    if (t.slice(0, 3).toLowerCase() === "xml" && (t.length === 3 || isSpace(t.charCodeAt(3)) || t[3] === "?")) {
      throw new Fail("XML_SYNTAX", this.i);
    }
    this.skip("?>", "XML_SYNTAX");
  }

  private skip(end: string, code: XmlErrorCode): void {
    const j = this.s.indexOf(end, this.i + 2);
    if (j < 0) throw new Fail(code, this.i);
    this.i = j + end.length;
  }

  private space(): boolean {
    const start = this.i;
    while (isSpace(this.s.charCodeAt(this.i))) this.i++;
    return this.i > start;
  }

  private expect(c: string): void {
    if (this.s[this.i] !== c) throw new Fail("XML_SYNTAX", this.i);
    this.i++;
  }
}

function text(el: XmlElement, t: string): void {
  if (!t) return;
  const last = el.children.length - 1;
  if (typeof el.children[last] === "string") el.children[last] += t; else el.children.push(t);
}

function entity(ref: string, at: number): string {
  const named = Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : undefined;
  if (named !== undefined) return named;
  const hex = ref.startsWith("#x"), digits = ref.slice(hex ? 2 : 1);
  if (ref[0] !== "#" || !digits || !(hex ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/).test(digits)) throw new Fail("XML_ENTITY", at);
  const cp = parseInt(digits, hex ? 16 : 10);
  const ok = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
  if (!ok) throw new Fail("XML_ENTITY", at);
  return String.fromCodePoint(cp);
}

function isSpace(c: number): boolean { return c === 0x20 || c === 0x9 || c === 0xa || c === 0xd; }

/** Имя XML упрощённо: буквы (включая не ASCII), цифры, `_ : - .`; первым — не цифра, не `-` и не `.`. */
function isNameChar(c: number, first: boolean): boolean {
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a || c >= 0xc0) return true;
  return !first && ((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0xb7);
}

/** Дочерние элементы с именем. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== "string" && c.name === name);
}

/** Первый дочерний элемент с именем. */
export function childNamed(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c): c is XmlElement => typeof c !== "string" && c.name === name);
}

/** Текст элемента без вложенных элементов. */
export function textOf(el: XmlElement): string {
  return el.children.filter((c): c is string => typeof c === "string").join("");
}
