import { describe, expect, it } from "vitest";
import { childNamed, childrenNamed, parseXml, textOf, type XmlElement, type XmlResult } from "../src/catalog/xml.js";
import { linearInWorker } from "./linear.js";

function root(r: XmlResult): XmlElement {
  if (!r.ok) throw new Error(`${r.code} @ ${r.offset}`);
  return r.root;
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE yml_catalog SYSTEM "shops.dtd">
<yml_catalog date="2026-10-17T09:00+03:00">
  <!-- комментарий -->
  <shop>
    <name>Масса Мадре</name>
    <offers>
      <offer id="tartine" available="true">
        <name>Тартин &amp; закваска</name>
        <price>250</price>
        <description><![CDATA[<p>Хлеб на закваске</p>]]></description>
        <param name="вес" unit="г">500</param>
      </offer>
      <offer id="b2"/>
    </offers>
  </shop>
</yml_catalog>`;

describe("разборщик XML (К14 п. 5)", () => {
  it("обычный фид: элементы, атрибуты, текст, CDATA, комментарий, шапка shops.dtd", () => {
    const r = root(parseXml(FEED));
    expect(r.name).toBe("yml_catalog");
    expect(r.attrs.date).toBe("2026-10-17T09:00+03:00");
    const offers = childrenNamed(childNamed(childNamed(r, "shop")!, "offers")!, "offer");
    expect(offers.map((o) => o.attrs.id)).toEqual(["tartine", "b2"]);
    const t = offers[0]!;
    expect(textOf(childNamed(t, "name")!)).toBe("Тартин & закваска");
    expect(textOf(childNamed(t, "description")!)).toBe("<p>Хлеб на закваске</p>");
    expect(childNamed(t, "param")!.attrs).toEqual({ name: "вес", unit: "г" });
    expect(Object.getPrototypeOf(t.attrs)).toBeNull();
  });

  it("Buffer: UTF-8 с BOM и без, windows-1251 по объявлению", () => {
    const xml = "<r>Тартин</r>";
    expect(textOf(root(parseXml(Buffer.from(xml))))).toBe("Тартин");
    expect(textOf(root(parseXml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]))))).toBe("Тартин");
    const cp1251 = Buffer.concat([Buffer.from(`<?xml version="1.0" encoding="windows-1251"?><r>`), Buffer.from([0xd2, 0xe0, 0xf0, 0xf2, 0xe8, 0xed]), Buffer.from("</r>")]);
    expect(textOf(root(parseXml(cp1251)))).toBe("Тартин");
  });

  it("кодировка: неизвестная, UTF-16 и неверные байты UTF-8 — XML_ENCODING", () => {
    expect(parseXml(Buffer.from(`<?xml version="1.0" encoding="koi8-r"?><r/>`))).toEqual({ ok: false, code: "XML_ENCODING", offset: 0 });
    expect(parseXml(Buffer.from([0xff, 0xfe, 0x3c, 0x00]))).toMatchObject({ ok: false, code: "XML_ENCODING" });
    expect(parseXml(Buffer.from([0x3c, 0x72, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x72, 0x3e]))).toMatchObject({ ok: false, code: "XML_ENCODING" });
  });

  it("сущности: пять предопределённых и числовые; переводы строк из ссылок сохраняются в атрибуте", () => {
    const r = root(parseXml(`<r a="x&#10;y\nz">&lt;&gt;&amp;&quot;&apos;&#8381;&#x20BD;\r\n</r>`));
    expect(textOf(r)).toBe(`<>&"'₽₽\n`);
    expect(r.attrs.a).toBe("x\ny z");
  });

  it("«бомба» сущностей (billion laughs) — XML_DOCTYPE, ничего не раскрывается", () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;
    expect(parseXml(bomb)).toMatchObject({ ok: false, code: "XML_DOCTYPE" });
  });

  it("внешняя сущность (XXE) во внутреннем подмножестве — XML_DOCTYPE", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
    expect(parseXml(xxe)).toMatchObject({ ok: false, code: "XML_DOCTYPE" });
  });

  it("сущность из внешнего DTD при пропущенной шапке — XML_ENTITY, DTD не читается", () => {
    expect(parseXml(`<!DOCTYPE r SYSTEM "http://example.invalid/x.dtd"><r>&foo;</r>`)).toEqual({ ok: false, code: "XML_ENTITY", offset: 53 });
    expect(parseXml(`<r>&#0;</r>`)).toMatchObject({ ok: false, code: "XML_ENTITY" });
    expect(parseXml(`<r>a & b</r>`)).toMatchObject({ ok: false, code: "XML_ENTITY" });
  });

  it("DOCTYPE: короткие формы проходят; повторный, после корня, иной формы, длиннее 1 КиБ — XML_DOCTYPE", () => {
    for (const d of [`<!DOCTYPE r>`, `<!DOCTYPE r SYSTEM "shops.dtd">`, `<!DOCTYPE r PUBLIC "-//X//DTD r//RU" 'r.dtd'>`]) {
      expect(root(parseXml(`${d}<r/>`)).name).toBe("r");
    }
    for (const bad of [
      `<!DOCTYPE r><!DOCTYPE r><r/>`,
      `<r/><!DOCTYPE r>`,
      `<!DOCTYPE r SYSTEM>`,
      `<!DOCTYPE r FOO "x"><r/>`,
      `<!DOCTYPE r PUBLIC "x"><r/>`,
      `<!DOCTYPE r SYSTEM "${"x".repeat(1024)}"><r/>`,
      `<!DOCTYPE r SYSTEM "a" [ ]><r/>`,
    ]) expect(parseXml(bad), bad).toMatchObject({ ok: false, code: "XML_DOCTYPE" });
    // `[` в кавычках — часть адреса, не внутреннее подмножество
    expect(root(parseXml(`<!DOCTYPE r SYSTEM "a[1].dtd"><r/>`)).name).toBe("r");
  });

  it("пределы: размер, глубина, число атрибутов — XML_LIMIT; неверный предел — RangeError", () => {
    expect(parseXml("<r>" + "а".repeat(10) + "</r>", { maxBytes: 20 })).toEqual({ ok: false, code: "XML_LIMIT", offset: 0 });
    expect(parseXml(Buffer.alloc(21, 0x20), { maxBytes: 20 })).toEqual({ ok: false, code: "XML_LIMIT", offset: 0 });
    expect(root(parseXml("<a><b><c/></b></a>", { maxDepth: 2 })).name).toBe("a");
    expect(parseXml("<a><b><c></c></b></a>", { maxDepth: 2 })).toMatchObject({ ok: false, code: "XML_LIMIT" });
    expect(parseXml("<a>".repeat(65) + "</a>".repeat(65))).toMatchObject({ ok: false, code: "XML_LIMIT" });
    const attrs = (n: number) => `<r ${Array.from({ length: n }, (_, i) => `a${i}="1"`).join(" ")}/>`;
    expect(parseXml(attrs(256)).ok).toBe(true);
    expect(parseXml(attrs(257))).toMatchObject({ ok: false, code: "XML_LIMIT" });
    expect(() => parseXml("<r/>", { maxDepth: 0 })).toThrow(RangeError);
    expect(() => parseXml("<r/>", { maxBytes: 1.5 })).toThrow(RangeError);
  });

  it("синтаксис: несовпадающий тег, повтор атрибута, два корня, текст вне корня, незакрытое — XML_SYNTAX", () => {
    for (const bad of [
      "", "текст", "<a></b>", "</a>", "<a>", "<a b='1' b='2'/>", "<a/><b/>", "x<a/>", "<a/>x", "<a b=1/>", "<a b='<'/>",
      "<a b='1'c='2'/>", "<a><!-- </a>", "<a><![CDATA[x</a>", "<![CDATA[x]]><a/>", "<a/><?xml version='1.0'?>",
    ]) expect(parseXml(bad), bad).toMatchObject({ ok: false, code: "XML_SYNTAX" });
  });

  it("инструкции обработки пропускаются, вложенный текст сливается с CDATA", () => {
    const r = root(parseXml(`<?xml version="1.0"?><?xml-stylesheet href="a"?><r>a<![CDATA[b]]>c<?pi x?>d</r>`));
    expect(r.children).toEqual(["abcd"]);
  });

  it("линейное время на 1 000 000 символов (worker)", async () => {
    expect(await linearInWorker("xml", 1_000_000)).toEqual([
      "ok", "ok", "ok", "ok", "XML_SYNTAX", "XML_SYNTAX", "XML_SYNTAX", "ok", "XML_DOCTYPE", "XML_ENTITY", "XML_SYNTAX",
    ]);
  });
});
