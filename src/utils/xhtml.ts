/**
 * Tag/attribute-level helpers for the XHTML fragments Google serves.
 *
 * These deliberately work on the raw markup instead of a DOM: rewriting only the
 * attribute values we care about keeps the rest of the publisher's XHTML byte-for-byte
 * intact, which a parse/serialise round-trip would not.
 */
import { normalizeResourceUrl } from "./play-api";

const TAG_RE = /<([A-Za-z][\w:.-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

// Which attributes carry an embedded resource, per element.
const RESOURCE_ATTRS: Record<string, string[]> = {
  img: ["src"],
  image: ["xlink:href", "href"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
};

function rewriteAttributes(
  attrs: string,
  fn: (name: string, value: string) => string | null | undefined,
): string {
  return attrs.replace(ATTR_RE, (whole, name: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare;
    if (value === undefined) return whole;
    const replaced = fn(name, value);
    if (replaced === undefined) return whole;
    if (replaced === null) return "";
    const quote = sq !== undefined && !replaced.includes("'") ? "'" : '"';
    return `${name}=${quote}${replaced}${quote}`;
  });
}

/**
 * Calls `fn` for every start tag; `fn` may return replacement attribute values.
 */
function mapTags(
  html: string,
  fn: (tag: string, name: string, value: string) => string | null | undefined,
): string {
  return html.replace(TAG_RE, (whole, tag: string, attrs: string, selfClose: string) => {
    if (!attrs) return whole;
    const rewritten = rewriteAttributes(attrs, (name, value) => fn(tag.toLowerCase(), name.toLowerCase(), value));
    if (rewritten === attrs) return whole;
    // Trailing whitespace is left behind when the last attribute was dropped.
    return `<${tag}${rewritten.replace(/\s+$/, "")}${selfClose ? " /" : ""}>`;
  });
}

/**
 * Every absolute resource URL referenced from the markup and stylesheets.
 */
export function collectResourceUrls(html: string, cssTexts: string[] = []): string[] {
  const urls = new Set<string>();
  const add = (raw: string) => {
    const url = normalizeResourceUrl(decodeEntities(raw));
    if (url) urls.add(url);
  };
  mapTags(html, (tag, name, value) => {
    if (RESOURCE_ATTRS[tag]?.includes(name)) add(value);
    return undefined;
  });
  for (const css of [html, ...cssTexts]) {
    for (const match of css.matchAll(CSS_URL_RE)) add(match[2]);
  }
  return [...urls];
}

/**
 * Rewrites resource URLs (in resource attributes, inline styles and <style>) through `resolve`.
 * `resolve` gets the normalised absolute URL and returns the local href, or null to keep it.
 */
export function rewriteResourceUrls(html: string, resolve: (url: string) => string | null): string {
  const viaResolve = (raw: string): string | undefined => {
    const url = normalizeResourceUrl(decodeEntities(raw));
    if (!url) return undefined;
    return resolve(url) ?? undefined;
  };
  const withAttrs = mapTags(html, (tag, name, value) => {
    if (RESOURCE_ATTRS[tag]?.includes(name)) return viaResolve(value);
    if (name === "style") return rewriteCssUrls(value, resolve);
    return undefined;
  });
  return withAttrs.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open: string, body: string, close: string) =>
    open + rewriteCssUrls(body, resolve) + close,
  );
}

export function rewriteCssUrls(css: string, resolve: (url: string) => string | null): string {
  return css.replace(CSS_URL_RE, (whole, _quote: string, raw: string) => {
    const url = normalizeResourceUrl(decodeEntities(raw));
    const local = url ? resolve(url) : null;
    // Unquoted on purpose: this may sit inside a double-quoted style="" attribute.
    // Local hrefs are generated from [A-Za-z0-9._/-] only.
    return local ? `url(${local})` : whole;
  });
}

/**
 * All `id` attribute values in the markup.
 */
export function collectIds(html: string): string[] {
  const ids: string[] = [];
  mapTags(html, (_tag, name, value) => {
    if (name === "id") ids.push(decodeEntities(value));
    return undefined;
  });
  return ids;
}

/**
 * Rewrites same-document fragment links (`href="#id"`) whose target lives in another file.
 * `resolve` returns the new href, or null when the target doesn't exist anywhere
 * (the href is then dropped so the link doesn't dangle).
 */
export function rewriteFragmentLinks(html: string, resolve: (id: string) => string | null): string {
  return mapTags(html, (tag, name, value) => {
    if (tag !== "a" || name !== "href" || !value.startsWith("#") || value.length < 2) return undefined;
    const target = resolve(decodeEntities(value.slice(1)));
    if (target === null) return null;
    return target === value ? undefined : escapeAttr(target);
  });
}

/**
 * True when the segment has something to show: visible text or an image.
 * Segments outside a preview come back with no (or only anchor) markup.
 */
export function hasReadableContent(html: string): boolean {
  if (/<(?:img|svg|image|video|object|embed)\b/i.test(html)) return true;
  return visibleText(html).length > 0;
}

export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[​­﻿]/g, "") // zero-width characters JS's \s doesn't cover
    .replace(/\s+/g, " ")
    .trim();
}

const VIETNAMESE_RE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu;

/**
 * Guesses the language of a text sample from its script. Returns null when unsure.
 * Google's manifest often says "en" for translated books, so this is used to correct it.
 */
export function guessLanguage(text: string): string | null {
  const sample = text.slice(0, 200_000);
  const letters = sample.match(/\p{L}/gu)?.length || 0;
  if (letters < 200) return null;
  const count = (re: RegExp) => sample.match(re)?.length || 0;
  const kana = count(/[぀-ヿ]/g);
  const han = count(/[一-鿿]/g);
  const hangul = count(/[가-힯]/g);
  if (kana / letters > 0.05) return "ja";
  if (hangul / letters > 0.2) return "ko";
  if (han / letters > 0.3) return "zh";
  if (count(VIETNAMESE_RE) / letters > 0.03) return "vi";
  return null;
}

// Named entities that show up in publisher XHTML. Unknown names are left as written.
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwsp: "​", shy: "­",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    .replace(/&amp;/g, "&");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
