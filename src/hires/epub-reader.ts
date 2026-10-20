import fs from "fs";
import path from "path";
import { unzipSync, strFromU8 } from "fflate";
import { logger } from "../utils/logger";
import { decodeEntities } from "../utils/xhtml";
import { ImgInfo, hashImage } from "./image-hash";

export interface EpubInfo {
  path: string;
  opfPath: string;
  opfXml: string;
  entries: Record<string, Uint8Array>; // zip contents, in archive order
  images: ImgInfo[];
  cover?: string;
  volumeId?: string;
  title: string;
}

const XML_ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XHTML_REF_RE = /<(?:img|image|source|video)\b[^>]*?\b(?:src|xlink:href|href|poster)\s*=\s*["']([^"'#]+)/gi;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(XML_ATTR_RE)) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

function tags(xml: string, name: string): Record<string, string>[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`, "gi");
  return [...xml.matchAll(re)].map((m) => attrs(m[0]));
}

/**
 * Resolves an href relative to the directory of the document that contains it.
 */
export function resolveHref(baseDir: string, href: string): string {
  let clean = href.split("#")[0].split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep it as written
  }
  const joined = path.posix.normalize(baseDir ? path.posix.join(baseDir, clean) : clean);
  return joined.replace(/^(\.\/)+/, "");
}

export function detectVolumeId(opfXml: string): string | undefined {
  const fromUrl = opfXml.match(/google\.[a-z.]+\/[^"'<\s]*?(?:books|reader|details)\?[^"'<\s]*?\bid=([A-Za-z0-9_-]{12})\b/);
  if (fromUrl) return fromUrl[1];
  const fromId = opfXml.match(/<dc:identifier[^>]*>\s*(?:urn:)?(?:gbs|google|playbooks)?:?([A-Za-z0-9_-]{12})\s*</i);
  return fromId?.[1];
}

/**
 * Reads an EPUB: its OPF, every manifest image (with dimensions and, optionally,
 * perceptual hashes) and the order in which the spine first references each image.
 */
export async function loadEpub(epubPath: string, withHashes = true): Promise<EpubInfo> {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(epubPath)));
  const names = Object.keys(entries);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const find = (p: string) => (entries[p] ? p : lower.get(p.toLowerCase()));

  let opfPath: string | undefined;
  if (entries["META-INF/container.xml"]) {
    opfPath = tags(strFromU8(entries["META-INF/container.xml"]), "rootfile").find((r) => r["full-path"])?.["full-path"];
  }
  if (!opfPath || !entries[opfPath]) opfPath = names.find((n) => n.toLowerCase().endsWith(".opf"));
  if (!opfPath) throw new Error("OPF not found; not a valid EPUB");

  const opfXml = strFromU8(entries[opfPath]);
  const opfDir = path.posix.dirname(opfPath) === "." ? "" : path.posix.dirname(opfPath);
  const items = new Map(tags(opfXml, "item").map((it) => [it.id || "", it]));
  const spine = tags(opfXml, "itemref").map((it) => it.idref || "");
  const title = decodeEntities(opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() || "");
  const coverId = tags(opfXml, "meta").find((m) => m.name === "cover")?.content;

  const images = new Map<string, ImgInfo>();
  let cover: string | undefined;
  for (const [id, item] of items) {
    const mediaType = (item["media-type"] || "").toLowerCase();
    if (!mediaType.startsWith("image/") || !item.href) continue;
    const zipPath = find(resolveHref(opfDir, item.href));
    if (!zipPath) {
      logger.warn(`Manifest item ${item.href} is missing from the ZIP; skipped`);
      continue;
    }
    const isCover = id === coverId || (item.properties || "").split(/\s+/).includes("cover-image");
    if (isCover) cover = zipPath;
    const data = Buffer.from(entries[zipPath]);
    const fields = { id: zipPath, path: zipPath, mediaType, label: isCover ? "cover" : "" };
    // SVG and unreadable images are listed (for the report) but never matched.
    const info: ImgInfo = (mediaType !== "image/svg+xml" && (await hashImage(data, fields, withHashes))) || {
      ...fields, width: 0, height: 0, format: "", order: 1, seq: -1, phash: 0n, dhash: 0n, bytes: data.length, hashable: false,
    };
    images.set(zipPath, info);
  }
  const unreadable = [...images.values()].filter((i) => !i.format && i.mediaType !== "image/svg+xml");
  if (unreadable.length && entries["META-INF/encryption.xml"]) {
    logger.warn(`${unreadable.length} images can't be parsed and the EPUB has META-INF/encryption.xml; it may still be DRM-encrypted.`);
  }

  // Reading order: the first time each image is referenced while walking the spine.
  let seq = 0;
  for (const idref of spine) {
    const item = items.get(idref);
    if (!item || !/^(application\/xhtml|text\/html)/.test(item["media-type"] || "")) continue;
    const docPath = find(resolveHref(opfDir, item.href || ""));
    if (!docPath) continue;
    const text = strFromU8(entries[docPath]);
    const base = path.posix.dirname(docPath) === "." ? "" : path.posix.dirname(docPath);
    const refs = [...text.matchAll(XHTML_REF_RE), ...text.matchAll(CSS_URL_RE)].map((m) => m[1]);
    for (const ref of refs) {
      const target = find(resolveHref(base, decodeEntities(ref)));
      const image = target ? images.get(target) : undefined;
      if (image && image.seq < 0) image.seq = seq++;
    }
  }
  const total = Math.max(seq, 1);
  for (const image of images.values()) image.order = image.seq >= 0 ? image.seq / total : 1;

  return {
    path: epubPath,
    opfPath,
    opfXml,
    entries,
    images: [...images.values()],
    cover,
    volumeId: detectVolumeId(opfXml),
    title,
  };
}
