import crypto from "crypto";
import fs from "fs";
import archiver from "archiver";
import { escapeXml } from "./text";

export interface TocItem {
  title: string;
  href: string;
  depth?: number;
}

export interface BookMetadata {
  title: string;
  authors: string[];
  publisher: string;
  pubDate: string;
  language: string;
  volumeId: string;
  isRightToLeft?: boolean;
  isFixedLayout?: boolean;
  viewport?: { width: string | number; height: string | number };
  tocItems?: TocItem[];
  omitCoverPage?: boolean; // keep the cover image in the manifest but don't add a cover page to the spine
}

export interface Chapter {
  label: string; // file stem: written as `${label}.xhtml` / `${label}.css`
  title: string;
  xhtml: string;
  css: string;
  pageImage?: { width: number; height: number }; // set for a scanned page shown as a single image
}

export interface Cover {
  data: Buffer;
  mimeType: string;
}

export interface EpubImage {
  filename: string; // e.g. "images/img1.png"
  data: Buffer;
  mimeType: string;
}

interface TocNode {
  title: string;
  href: string;
  children: TocNode[];
}

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * RFC 4122 name-based (SHA-1) UUID, same as Python's uuid.uuid5.
 */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(ns).update(name, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable `urn:uuid` for a Play Books volume (identical to the Python tool's identifier).
 * Volume ids like "Hk3cEAAAQBAJ" aren't UUIDs, so they can't be used directly.
 */
export function bookIdentifier(volumeId: string): string {
  const namespace = uuidV5("play.google.com/books", DNS_NAMESPACE);
  return `urn:uuid:${uuidV5(`https://books.google.com/books?id=${volumeId}`, namespace)}`;
}

/**
 * Turns an arbitrary string into a valid, unique XML id (NCName).
 */
function makeIdFactory(): (raw: string) => string {
  const used = new Set<string>();
  return (raw: string) => {
    let base = raw.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `x${base}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
}

/**
 * Fallback TOC when the manifest has none: one entry per run of consecutive chapters
 * sharing a title (a chapter split into "id7" / "id7-ppd", or a scanned segment's pages).
 */
export function chapterToc(chapters: Chapter[]): TocItem[] {
  const items: TocItem[] = [];
  for (const chapter of chapters) {
    if (items.length && items[items.length - 1].title === chapter.title) continue;
    items.push({ title: chapter.title, href: `${chapter.label}.xhtml`, depth: 0 });
  }
  return items;
}

/**
 * Builds a nested TOC tree from a flat, depth-annotated list. Only exact repeats
 * (same title, target and depth in a row) are dropped; same-named entries pointing
 * to different places are distinct.
 */
export function buildTocTree(items: TocItem[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: { depth: number; children: TocNode[] }[] = [{ depth: -Infinity, children: root }];
  let previous: TocItem | undefined;
  for (const item of items) {
    if (
      previous &&
      previous.title === item.title &&
      previous.href === item.href &&
      (previous.depth || 0) === (item.depth || 0)
    ) {
      continue;
    }
    previous = item;
    const depth = item.depth || 0;
    const node: TocNode = { title: item.title, href: item.href, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children });
  }
  return root;
}

function tocDepth(nodes: TocNode[]): number {
  return nodes.reduce((max, node) => Math.max(max, 1 + tocDepth(node.children)), 0);
}

function renderNavList(nodes: TocNode[], indent: string): string {
  const items = nodes.map((node) => {
    const link = `<a href="${escapeXml(node.href)}">${escapeXml(node.title)}</a>`;
    if (!node.children.length) return `${indent}  <li>${link}</li>`;
    return `${indent}  <li>${link}\n${renderNavList(node.children, indent + "    ")}\n${indent}  </li>`;
  });
  return `${indent}<ol>\n${items.join("\n")}\n${indent}</ol>`;
}

function renderNavPoints(nodes: TocNode[], counter: { n: number }, indent: string): string {
  return nodes
    .map((node) => {
      counter.n++;
      const children = node.children.length ? "\n" + renderNavPoints(node.children, counter, indent + "  ") : "";
      return `${indent}<navPoint id="navPoint-${counter.n}" playOrder="${counter.n}">
${indent}  <navLabel><text>${escapeXml(node.title)}</text></navLabel>
${indent}  <content src="${escapeXml(node.href)}"/>${children}
${indent}</navPoint>`;
    })
    .join("\n");
}

/**
 * Builds a valid EPUB zip file from metadata, chapters, and optional cover image.
 */
export function buildEpub(
  outputPath: string,
  metadata: BookMetadata,
  chapters: Chapter[],
  cover?: Cover,
  images: EpubImage[] = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", {
      zlib: { level: 9 }, // Maximum compression for contents
    });

    output.on("close", () => resolve());
    output.on("error", (err) => reject(err));
    archive.on("error", (err) => reject(err));

    archive.pipe(output);

    // 1. mimetype (MUST be the first file, stored without compression)
    archive.append("application/epub+zip", { name: "mimetype", store: true });

    // 2. META-INF/container.xml
    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
    archive.append(containerXml, { name: "META-INF/container.xml" });

    const makeId = makeIdFactory();
    ["ncx", "nav", "cover-image", "cover-xhtml"].forEach(makeId);
    const identifier = bookIdentifier(metadata.volumeId);
    const language = metadata.language || "en";

    // Prepare variables for manifest and spine
    const coverExt = cover ? ({ "image/jpeg": "jpg", "image/svg+xml": "svg" }[cover.mimeType] || cover.mimeType.split("/")[1] || "jpg") : "jpg";
    const coverImageFilename = `cover.${coverExt}`;

    const coverPage = Boolean(cover && !metadata.omitCoverPage);

    // 3. OEBPS/cover.xhtml (if cover is provided)
    if (cover) {
      archive.append(cover.data, { name: `OEBPS/${coverImageFilename}` });
    }
    if (cover && coverPage) {
      const coverViewport = metadata.isFixedLayout && metadata.viewport
        ? `<meta name="viewport" content="width=${metadata.viewport.width}, height=${metadata.viewport.height}"/>`
        : '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>';
      const coverCss = metadata.isFixedLayout
        ? `html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
      div { width: 100%; height: 100%; }
      img { width: 100%; height: 100%; object-fit: contain; }`
        : `html, body { margin: 0; padding: 0; text-align: center; background-color: #ffffff; }
      div { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
      img { max-width: 100%; max-height: 100vh; height: auto; object-fit: contain; }`;

      const coverXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>Cover</title>
    ${coverViewport}
    <style type="text/css">
      ${coverCss}
    </style>
  </head>
  <body>
    <div>
      <img src="${coverImageFilename}" alt="Cover" />
    </div>
  </body>
</html>`;
      archive.append(coverXhtml, { name: "OEBPS/cover.xhtml" });
    }

    const effectiveToc: TocItem[] = metadata.tocItems && metadata.tocItems.length > 0
      ? metadata.tocItems
      : chapterToc(chapters);
    const tocTree = buildTocTree(effectiveToc);

    // 4. OEBPS/nav.xhtml (EPUB 3 Table of Contents)
    const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>${escapeXml(metadata.title)}</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <style>
      nav#toc ol { list-style-type: none; margin: 0; padding: 0; }
      nav#toc ol ol { padding-left: 1.5em; }
      nav#toc li { margin-bottom: 0.5em; }
      nav#toc a { text-decoration: none; color: #1a0dab; }
    </style>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Table of Contents</h1>
${renderNavList(tocTree, "      ")}
    </nav>
  </body>
</html>`;
    archive.append(navXhtml, { name: "OEBPS/nav.xhtml" });

    // 5. OEBPS/toc.ncx (EPUB 2 TOC fallback)
    const tocNcx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${identifier}"/>
    <meta name="dtb:depth" content="${Math.max(1, tocDepth(tocTree))}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${escapeXml(metadata.title)}</text>
  </docTitle>
  <navMap>
${renderNavPoints(tocTree, { n: 0 }, "    ")}
  </navMap>
</ncx>`;
    archive.append(tocNcx, { name: "OEBPS/toc.ncx" });

    // 6. OEBPS/content.opf (Book manifest & spine metadata)
    const formattedPubDate = metadata.pubDate.replace(/\./g, "-") || new Date().getFullYear().toString();
    const modifiedDate = new Date().toISOString().split(".")[0] + "Z";

    const chapterIds = chapters.map((chapter) => ({
      chapter,
      xhtmlId: makeId(`xhtml-${chapter.label}`),
      cssId: makeId(`css-${chapter.label}`),
    }));
    const imageIds = images.map((image) => ({ image, id: makeId(`img-${image.filename.replace(/^images\//, "")}`) }));
    const fixedProps = metadata.isFixedLayout ? ' properties="rendition:layout-pre-paginated"' : "";

    const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${identifier}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    ${metadata.authors
      .map(
        (author, idx) =>
          `<dc:creator id="creator-${idx}">${escapeXml(author)}</dc:creator>`
      )
      .join("\n    ")}
    <dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>
    <dc:date>${escapeXml(formattedPubDate)}</dc:date>
    <dc:language>${escapeXml(language)}</dc:language>
    <dc:source>https://books.google.com/books?id=${escapeXml(metadata.volumeId)}</dc:source>
    <meta property="dcterms:modified">${modifiedDate}</meta>
    ${
      metadata.isFixedLayout
        ? `<meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">auto</meta>${
      metadata.viewport
        ? `\n    <meta property="rendition:viewport">width=${metadata.viewport.width}, height=${metadata.viewport.height}</meta>`
        : ""
    }`
        : `<meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:spread">auto</meta>`
    }
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${cover ? `<item id="cover-image" href="${coverImageFilename}" media-type="${cover.mimeType}" properties="cover-image"/>` : ""}
    ${coverPage ? `<item id="cover-xhtml" href="cover.xhtml" media-type="application/xhtml+xml"/>` : ""}
${chapterIds
  .map(
    ({ chapter, xhtmlId, cssId }) =>
      `    <item id="${xhtmlId}" href="${escapeXml(chapter.label)}.xhtml" media-type="application/xhtml+xml"/>
    <item id="${cssId}" href="${escapeXml(chapter.label)}.css" media-type="text/css"/>`
  )
  .join("\n")}
${imageIds
  .map(({ image, id }) => `    <item id="${id}" href="${escapeXml(image.filename)}" media-type="${image.mimeType}"/>`)
  .join("\n")}
  </manifest>
  <spine${metadata.isRightToLeft ? ' page-progression-direction="rtl"' : ""} toc="ncx">
    ${coverPage ? `<itemref idref="cover-xhtml"${fixedProps}/>` : ""}
${chapterIds.map(({ xhtmlId }) => `    <itemref idref="${xhtmlId}"${fixedProps}/>`).join("\n")}
  </spine>
</package>`;
    archive.append(contentOpf, { name: "OEBPS/content.opf" });

    // Add chapters (XHTML and CSS files)
    for (const chapter of chapters) {
      archive.append(chapter.xhtml, { name: `OEBPS/${chapter.label}.xhtml` });
      archive.append(chapter.css, { name: `OEBPS/${chapter.label}.css` });
    }

    // Add inline images
    for (const image of images) {
      archive.append(image.data, { name: `OEBPS/${image.filename}` });
    }

    archive.finalize();
  });
}
