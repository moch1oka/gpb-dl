import crypto from "crypto";
import fs from "fs";
import path from "path";
import { BaseDownloader, DownloaderOptions } from "./base";
import { buildEpub, Chapter, Cover, EpubImage, TocItem } from "../utils/epub-builder";
import { logger, withSpinner } from "../utils/logger";
import { GoogleBookManifest, GoogleBookPageManifest, GoogleBookSegmentManifest } from "../types";
import { safeName, unescapeHtml, escapeXml } from "../utils/text";
import { delay, concurrentMap } from "../utils/async";
import { compareCovers, storeCoverWins } from "../utils/image-compare";
import {
  DownloadedImage,
  MIME_EXTENSION,
  SegmentObject,
  SegmentPage,
  downloadOriginalImage,
  fetchPlayImage,
  fetchSegment,
  fetchSegmentCss,
  isFontUrl,
  pageImageUrl,
  probeImage,
  resourceId,
} from "../utils/play-api";
import { findPageIllustrations, hasPageEdition, shortHash } from "../utils/page-illustrations";
import {
  collectIds,
  collectResourceUrls,
  guessLanguage,
  hasReadableContent,
  rewriteCssUrls,
  rewriteFragmentLinks,
  rewriteResourceUrls,
  visibleText,
} from "../utils/xhtml";

/**
 * A downloaded segment: usually one chapter, one per page for scanned segments,
 * none when it has no content (outside a preview) or failed.
 */
interface SegmentResult {
  index: number;
  chapters: Chapter[];
  missing: boolean;
}

export class EpubDownloader extends BaseDownloader {
  private epubImages: EpubImage[] = [];
  private imagesByHash = new Map<string, EpubImage>();
  private imageNames = new Set<string>();
  private imageByUrl = new Map<string, Promise<string | null>>();
  private cssByUrl = new Map<string, Promise<string>>();

  constructor(bookId: string, options: DownloaderOptions) {
    super(bookId, options);
  }

  private resetResources(): void {
    this.epubImages = [];
    this.imagesByHash.clear();
    this.imageNames.clear();
    this.imageByUrl.clear();
    this.cssByUrl.clear();
  }

  /**
   * Stores image bytes in the EPUB once (deduplicated by content) and returns its href.
   */
  private addImage(data: Buffer, mimeType: string, nameHint: string): string {
    const hash = crypto.createHash("sha1").update(data).digest("hex");
    const existing = this.imagesByHash.get(hash);
    if (existing) return existing.filename;

    const ext = MIME_EXTENSION[mimeType] || "bin";
    const stem = nameHint.replace(/\.[A-Za-z0-9]{2,4}$/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || hash.slice(0, 16);
    let filename = `images/${stem}.${ext}`;
    if (this.imageNames.has(filename)) filename = `images/${stem}_${hash.slice(0, 8)}.${ext}`;
    this.imageNames.add(filename);

    const image = { filename, data, mimeType };
    this.imagesByHash.set(hash, image);
    this.epubImages.push(image);
    return filename;
  }

  /**
   * Downloads an image referenced by a segment at its original resolution
   * (once per URL) and returns its in-EPUB href, or null if it couldn't be fetched.
   */
  private localImage(url: string, aesKey?: Buffer): Promise<string | null> {
    let pending = this.imageByUrl.get(url);
    if (!pending) {
      pending = (async () => {
        try {
          const image = await downloadOriginalImage(url, this.headers, aesKey);
          logger.debug(`Downloaded image ${resourceId(url)} (${image.width}x${image.height} ${image.format})`);
          return this.addImage(image.data, image.mimeType, resourceId(url));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logWarn(`Failed to download image ${url}: ${msg}`);
          return null;
        }
      })();
      this.imageByUrl.set(url, pending);
    }
    return pending;
  }

  /**
   * Finds every image referenced by the segment's markup/CSS, embeds the original-resolution
   * files and points the references at them.
   */
  async embedResources(html: string, css: string, aesKey?: Buffer): Promise<{ html: string; css: string }> {
    // Fonts aren't bundled (cleanSegmentCss drops the reader font), so don't fetch them as images.
    const urls = collectResourceUrls(html, [css]).filter((url) => {
      if (!isFontUrl(url)) return true;
      logger.debug(`Skipping font resource: ${url}`);
      return false;
    });
    const local = new Map<string, string>();
    await Promise.all(
      urls.map(async (url) => {
        const href = await this.localImage(url, aesKey);
        if (href) local.set(url, href);
      }),
    );
    const resolve = (url: string) => local.get(url) ?? null;
    return { html: rewriteResourceUrls(html, resolve), css: rewriteCssUrls(css, resolve) };
  }

  /**
   * The segment stylesheet: inline `style` when present, otherwise the CSS files listed
   * in the segment's resources (the reader request parameters move it there).
   */
  private async segmentCss(segmentObj: SegmentObject, segment: GoogleBookSegmentManifest, aesKey?: Buffer): Promise<string> {
    if (segmentObj.style) return segmentObj.style;
    const urls = new Set<string>();
    for (const res of [...(segmentObj.resource || []), ...(segment.resource || [])]) {
      if (res.url && (res.mime_type || "").startsWith("text/css")) urls.add(res.url);
    }
    const sheets = await Promise.all(
      [...urls].map((url) => {
        let pending = this.cssByUrl.get(url);
        if (!pending) {
          pending = fetchSegmentCss(url, this.headers, aesKey).catch((err) => {
            this.logWarn(`Failed to download stylesheet ${url}: ${err instanceof Error ? err.message : String(err)}`);
            return "";
          });
          this.cssByUrl.set(url, pending);
        }
        return pending;
      }),
    );
    return sheets.join("\n");
  }

  /**
   * Ensures the XHTML has a link to its stylesheet and standard XHTML document structure with viewport.
   */
  linkStylesheet(
    xhtml: string,
    label: string,
    title?: string,
    viewport?: { width: string | number; height: string | number },
    isFixedLayout?: boolean,
    language?: string
  ): string {
    const linkTag = `<link rel="stylesheet" type="text/css" href="${label}.css" />`;
    const docTitle = escapeXml(title || label);
    const vpTag = isFixedLayout && viewport
      ? `<meta name="viewport" content="width=${viewport.width}, height=${viewport.height}" />`
      : `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`;
    const langAttrs = language ? ` xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}"` : "";

    if (xhtml.includes("<html")) {
      let res = xhtml;
      if (!res.includes("name=\"viewport\"")) {
        if (res.includes("</head>")) {
          res = res.replace("</head>", `  ${vpTag}\n</head>`);
        } else if (res.includes("<head>")) {
          res = res.replace("<head>", `<head>\n  ${vpTag}`);
        }
      }
      if (res.includes("</head>")) {
        return res.replace("</head>", `  ${linkTag}\n</head>`);
      }
      return res.replace("<head>", `<head>\n  ${linkTag}`);
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"${langAttrs}>
<head>
  <meta charset="utf-8" />
  ${vpTag}
  <title>${docTitle}</title>
  ${linkTag}
</head>
<body>
${xhtml}
</body>
</html>`;
  }

  /**
   * Downloads or loads the book cover image based on user choice (--cover option).
   * Supports:
   * - "auto" (default): prefers PP1 / first page from manifest, falls back to frontcover endpoint.
   * - "frontcover" / "thumbnail": forces Google Books public frontcover thumbnail.
   * - page ID (e.g. "PP1", "PP2", "PA1"): downloads and decrypts that specific page.
   * - local file path (e.g. "./cover.jpg"): loads a local image file.
   * - "none" / "off": skips cover page generation.
   */
  async downloadCover(manifest?: GoogleBookManifest, aesKey?: Buffer): Promise<Cover | undefined> {
    const coverChoice = (this.options.cover || "auto").trim();
    const lowerChoice = coverChoice.toLowerCase();

    // 1. Skip cover if explicitly disabled
    if (lowerChoice === "none" || lowerChoice === "off" || lowerChoice === "false") {
      logger.info("Cover generation skipped by user option (--cover none).");
      return undefined;
    }

    // 2. Check if coverChoice is a local image file path
    if (fs.existsSync(coverChoice) && fs.statSync(coverChoice).isFile()) {
      try {
        logger.info(`Using local image file for cover: ${coverChoice}`);
        const data = fs.readFileSync(coverChoice);
        let mimeType = "image/jpeg";
        const ext = path.extname(coverChoice).toLowerCase();
        if (ext === ".png" || (data[0] === 0x89 && data[1] === 0x50)) {
          mimeType = "image/png";
        } else if (ext === ".webp") {
          mimeType = "image/webp";
        }
        return { data, mimeType };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logWarn(`Failed to load local cover file: ${msg}`);
      }
    }

    // Helper to download and decrypt a specific page image
    const downloadPageCover = async (page: GoogleBookPageManifest): Promise<Cover | null> => {
      if (!page.src || !aesKey) return null;
      logger.info(`Downloading cover from book page (${page.pid})...`);
      const image = await fetchPlayImage(pageImageUrl(page.src), this.headers, aesKey);
      if (typeof image === "string") {
        logger.debug(`Failed to download page ${page.pid} as cover: ${image}`);
        return null;
      }
      return { data: image.data, mimeType: image.mimeType };
    };

    const downloadFrontcover = () => this.downloadFrontcover();

    // 3. Forced frontcover thumbnail requested
    if (lowerChoice === "frontcover" || lowerChoice === "thumbnail" || lowerChoice === "web") {
      const cover = await downloadFrontcover();
      if (cover) return cover;
      this.logWarn("Could not download frontcover image. EPUB will be built without a cover page.");
      return undefined;
    }

    // 4. Specific page ID requested (e.g. PP1, PP2, PA1, or numeric 0, 1)
    if (lowerChoice !== "auto" && manifest?.page && manifest.page.length > 0) {
      const targetPage =
        manifest.page.find((p) => p.pid.toLowerCase() === lowerChoice) ||
        manifest.page.find((p) => String(p.order) === lowerChoice) ||
        manifest.page.find((p) => String(p.order + 1) === lowerChoice);

      if (targetPage) {
        const cover = await downloadPageCover(targetPage);
        if (cover) return cover;
        this.logWarn(`Could not download specified page '${coverChoice}' as cover. Falling back...`);
      } else {
        this.logWarn(`Specified cover page '${coverChoice}' not found in manifest. Falling back...`);
      }
    }

    // 5. Default auto mode: intelligently compare first book page with official store cover
    const firstPage =
      manifest?.page && manifest.page.length > 0
        ? manifest.page.find((p) => p.pid === "PP1" && p.src) ||
          manifest.page.find((p) => p.order === 0 && p.src) ||
          manifest.page[0]
        : undefined;

    const [publisherCover, firstPageCover] = await Promise.all([
      downloadFrontcover(),
      firstPage && firstPage.src && aesKey ? downloadPageCover(firstPage) : Promise.resolve(null),
    ]);

    if (firstPageCover && publisherCover) {
      const comparison = await compareCovers(firstPageCover.data, publisherCover.data);
      if (comparison) {
        if (comparison.areSimilar) {
          // Same cover: keep the book's own page unless the store copy is much larger
          if (!storeCoverWins(comparison)) {
            logger.info(
              `First page (${firstPage?.pid}) matches store cover. Kept the book's own cover page (${comparison.dim1.width}x${comparison.dim1.height}, store ${comparison.dim2.width}x${comparison.dim2.height}).`
            );
            return firstPageCover;
          } else {
            logger.info(
              `First page (${firstPage?.pid}) matches store cover. Selected the much larger store cover (${comparison.dim2.width}x${comparison.dim2.height} vs ${comparison.dim1.width}x${comparison.dim1.height}).`
            );
            return publisherCover;
          }
        } else {
          logger.info(
            `First page (${firstPage?.pid}) differs from store cover. Selected official store cover (${comparison.dim2.width}x${comparison.dim2.height}).`
          );
          return publisherCover;
        }
      }
      return publisherCover;
    }

    if (publisherCover) return publisherCover;
    if (firstPageCover) return firstPageCover;

    this.logWarn("Could not download book cover. EPUB will be built without a cover page.");
    return undefined;
  }

  /**
   * Sanitizes and normalizes segment CSS for standard EPUB readers:
   * - Strips invalid @font-face blocks missing src: url(...)
   * - Replaces missing proprietary Bookerly font-family
   * - Fixes Google Books web dual-page max-width: 50% limit on images
   * - Removes @page { margin: 0; } in reflowable books to prevent margin stripping
   * - Injects standard responsive illustration styles
   */
  cleanSegmentCss(css: string, isFixedLayout: boolean): string {
    let result = css;

    // 0. Remove @font-face blocks for Google's reader font (Bookerly). The reader-style
    // segment request links it from books.googleusercontent.com; it isn't bundled, and
    // step 2 strips every font-family that would use it.
    result = result.replace(/@font-face\s*\{[^}]*bookerly[^}]*\}/gi, "");

    // 1. Remove invalid @font-face blocks that lack url(...) or src
    result = result.replace(/@font-face\s*\{[^}]*format\("truetype"\);?[^}]*\}/gi, "");
    result = result.replace(/@font-face\s*\{(?![^}]*url\()[^}]*\}/gi, "");

    // 2. Remove hardcoded Bookerly font-family when font files are not bundled
    result = result.replace(/font-family:\s*['"]?bookerly(?:Bold|Italic|BoldItalic)?['"]?\s*;?/gi, "");

    // 3. Fix Google's dual-column web reader restriction (max-width: 50% -> 100%)
    result = result.replace(
      /(\.gb-segment\s+img\s*\{[^}]*?)max-width:\s*50%;?/gi,
      "$1max-width: 100%;"
    );

    // 4. In reflowable mode, remove @page { margin: 0 0 0 0; } so reader margins are respected
    // and replace orphans: 1 / widows: 1 with 2 to forbid single dangling lines across columns
    if (!isFixedLayout) {
      result = result.replace(/@page\s*\{[^}]*\}/gi, "");
      result = result.replace(/orphans:\s*1\s*;?/gi, "orphans: 2;");
      result = result.replace(/widows:\s*1\s*;?/gi, "widows: 2;");
    }

    // 5. Append universal illustration styles
    result += `
/* Standard EPUB reader compatibility styles */
img {
  max-width: 100%;
  height: auto;
}
.full-page-illustration-container {
  display: block;
  page-break-before: always;
  page-break-after: always;
  break-before: page;
  break-after: page;
  break-before: column;
  break-after: column;
  page-break-inside: avoid;
  break-inside: avoid;
  min-height: 95vh;
  margin: 0 auto;
  padding: 0;
  text-align: center;
}
.full-page-illustration-container img,
img.full-page-illustration {
  max-width: 100%;
  max-height: 95vh;
  height: auto;
  width: auto;
  object-fit: contain;
  margin: auto;
  display: block;
}
`;
    return result;
  }

  /**
   * Identifies large full-page illustrations in reflowable XHTML, wraps them in a
   * dedicated full-height container with page/column breaks, and ensures any subsequent
   * text paragraph starts cleanly on the next page/column without dangling lines.
   */
  formatReflowableIllustrations(html: string): string {
    return html.replace(
      /(<img\b[\s\S]*?\/?>)([\s\S]*?)(<p\b|$)/gi,
      (match: string, imgTag: string, middle: string, nextTag: string) => {
        const widthMatch = imgTag.match(/width=["']?(\d+)["']?/i);
        const heightMatch = imgTag.match(/height=["']?(\d+)["']?/i);
        const w = widthMatch ? parseInt(widthMatch[1], 10) : 0;
        const h = heightMatch ? parseInt(heightMatch[1], 10) : 0;

        // Identify full-page illustrations: height >= 600 or (width >= 600 and height >= 400)
        const isIllustration = h >= 600 || (w >= 600 && h >= 400);

        if (!isIllustration) {
          return match;
        }

        // Cleanly extract attributes without trailing / or >
        let cleanAttrs = imgTag
          .replace(/^<img\s*/i, "")
          .replace(/\s*\/?>$/i, "")
          .trim();

        // Merge class attribute cleanly
        if (/class=["']([^"']*)["']/i.test(cleanAttrs)) {
          cleanAttrs = cleanAttrs.replace(
            /class=["']([^"']*)["']/i,
            (_: string, existing: string) => `class="${existing} full-page-illustration"`
          );
        } else {
          cleanAttrs = `class="full-page-illustration" ${cleanAttrs}`;
        }

        // Clean and merge style attribute
        let existingStyle = "";
        const styleMatch = cleanAttrs.match(/style=["']([^"']*)["']/i);
        if (styleMatch) {
          existingStyle = styleMatch[1].trim();
          cleanAttrs = cleanAttrs.replace(/style=["'][^"']*["']/i, "").trim();
        }
        const combinedStyle = existingStyle
          ? `${existingStyle}; max-width: 100%; max-height: 95vh; height: auto; width: auto; object-fit: contain; display: block; margin: auto;`
          : `max-width: 100%; max-height: 95vh; height: auto; width: auto; object-fit: contain; display: block; margin: auto;`;

        const container = `<div class="full-page-illustration-container" style="page-break-before: always; page-break-after: always; break-before: page; break-after: page; break-before: column; break-after: column; page-break-inside: avoid; break-inside: avoid; min-height: 95vh; margin: 0 auto; padding: 0; text-align: center;">\n  <img ${cleanAttrs} style="${combinedStyle}" />\n</div>`;

        // If followed by a paragraph, ensure that paragraph starts on a new page/column
        let updatedNext = nextTag;
        if (nextTag && nextTag.startsWith("<p")) {
          if (/style=["']([^"']*)["']/i.test(nextTag)) {
            updatedNext = nextTag.replace(
              /style=["']([^"']*)["']/i,
              (_: string, s: string) => `style="${s}; page-break-before: always; break-before: page; break-before: column;"`
            );
          } else {
            updatedNext = nextTag.replace(
              /^<p\b/i,
              `<p style="page-break-before: always; break-before: page; break-before: column;"`
            );
          }
        }

        return container + middle + updatedNext;
      }
    );
  }

  /**
   * Downloads a scanned page image at its original size.
   *
   * Asking for the page's `original_w`/`original_h` returns the scan as stored. A larger
   * w/h (the old w=10000) only gets an upscaled copy capped at 2500px on the long side.
   */
  private async downloadPageImage(page: SegmentPage, aesKey: Buffer): Promise<DownloadedImage> {
    const size = page.original_w && page.original_h ? { width: page.original_w, height: page.original_h } : undefined;
    const image = await fetchPlayImage(pageImageUrl(page.src!, size), this.headers, aesKey);
    if (typeof image === "string") throw new Error(image);
    return image;
  }

  /**
   * Turns a segment that consists only of scanned pages ("Original pages" books, or
   * fixed-layout segments without markup) into one chapter per page, in reading order.
   * Putting all pages of a segment in one document would stack them on top of each other.
   */
  private async pageImageChapters(
    pages: SegmentPage[],
    fileStem: string,
    title: string,
    aesKey: Buffer,
  ): Promise<Chapter[]> {
    const ordered = [...pages].sort((a, b) => a.order - b.order);
    const chapters = await Promise.all(
      ordered.map(async (page): Promise<Chapter | null> => {
        try {
          logger.debug(`Downloading page image: ${page.pid}`);
          const image = await this.downloadPageImage(page, aesKey);
          const filename = this.addImage(image.data, image.mimeType, page.pid);
          return {
            label: `${fileStem}_${page.pid.replace(/[^A-Za-z0-9_-]/g, "_")}`,
            title,
            xhtml: `<div class="page-image" id="GBS.${escapeXml(page.pid)}"><img src="${filename}" alt="" width="${image.width}" height="${image.height}" /></div>`,
            css: "",
            pageImage: { width: image.width, height: image.height },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to download page image ${page.pid}: ${msg}`);
          return null;
        }
      }),
    );
    return chapters.filter((c): c is Chapter => c !== null);
  }

  /**
   * Whether `data` shows the same picture as the image embedded in `xhtml`.
   */
  private async isSameImage(data: Buffer, xhtml: string): Promise<boolean> {
    const src = xhtml.match(/<img\b[^>]*\bsrc="([^"]+)"/i)?.[1];
    const embedded = src ? this.epubImages.find((image) => image.filename === src) : undefined;
    return Boolean(embedded && (await compareCovers(data, embedded.data))?.areSimilar);
  }

  /**
   * Swaps embedded illustrations (and the cover) for sharper copies from the book's
   * "Original pages" edition, rewriting references in `chapters` in place.
   * Returns the upgraded cover, if any.
   */
  private async upgradeIllustrations(
    manifest: GoogleBookManifest,
    aesKey: Buffer,
    chapters: Chapter[],
    cover?: Cover,
  ): Promise<Cover | undefined> {
    const COVER_KEY = "\u0000cover";
    const candidates = this.epubImages.map((image) => ({ filename: image.filename, data: image.data }));
    if (cover) candidates.push({ filename: COVER_KEY, data: cover.data });

    const upgrades = await findPageIllustrations(manifest, candidates, this.headers, aesKey, this.options.concurrency || 1);
    if (!upgrades.size) {
      logger.info("No illustration in the page edition is sharper than the EPUB's own.");
      return undefined;
    }

    const lines: string[] = [];
    let newCover: Cover | undefined;
    for (const [filename, up] of upgrades) {
      if (filename === COVER_KEY) {
        newCover = { data: up.data, mimeType: up.mimeType };
        lines.push(`cover → page ${up.pid} ${up.width}x${up.height}`);
        continue;
      }
      const image = this.epubImages.find((img) => img.filename === filename);
      if (!image) continue;
      const old = await probeImage(image.data);
      const before = old ? `${old.width}x${old.height}` : "?";
      const ext = MIME_EXTENSION[up.mimeType] || "jpg";
      let renamed = filename.replace(/\.[^./]+$/, `.${ext}`);
      if (renamed !== filename && this.imageNames.has(renamed)) renamed = filename.replace(/\.[^./]+$/, `_${shortHash(up.data)}.${ext}`);
      this.imageNames.add(renamed);
      image.filename = renamed;
      image.data = up.data;
      image.mimeType = up.mimeType;
      if (renamed !== filename) {
        for (const chapter of chapters) {
          chapter.xhtml = chapter.xhtml.split(filename).join(renamed);
          chapter.css = chapter.css.split(filename).join(renamed);
        }
      }
      lines.push(`${filename.replace(/^images\//, "")} ${before} → page ${up.pid} ${up.width}x${up.height}`);
    }
    logger.success(`Replaced ${lines.length} illustrations with sharper ones from the page edition:\n${lines.join("\n")}`);
    return newCover;
  }

  /**
   * Stylesheet for a scanned-page document: the image fills the fixed-layout viewport,
   * or fits the screen in a reflowable book.
   */
  static pageImageCss(width: number, height: number, isFixedLayout: boolean): string {
    if (isFixedLayout) {
      return `html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
.page-image, .page-image img { display: block; margin: 0; padding: 0; width: ${width}px; height: ${height}px; }
`;
    }
    return `html, body { margin: 0; padding: 0; }
.page-image { text-align: center; page-break-before: always; break-before: page; page-break-inside: avoid; break-inside: avoid; }
.page-image img { display: block; margin: 0 auto; max-width: 100%; max-height: 100vh; width: auto; height: auto; object-fit: contain; }
`;
  }

  /**
   * Downloads and decrypts a single segment, embedding its page images, inline images and CSS.
   * Returns `missing: true` for segments Google serves without content (outside a preview).
   */
  private async downloadAndProcessSegment(
    segment: GoogleBookSegmentManifest,
    fileStem: string,
    aesKey: Buffer,
    isFixedLayout: boolean = false,
    viewport?: { width: string | number; height: string | number }
  ): Promise<{ chapters: Chapter[]; missing: boolean }> {
    const { label, link } = segment;
    const chapterTitle = segment.title ? unescapeHtml(segment.title) : undefined;

    if (!link) {
      logger.debug(`Skipped segment ${label} (missing link)`);
      return { chapters: [], missing: true };
    }

    try {
      const segmentObj = await fetchSegment(link, this.headers, aesKey);
      let segmentHtml = segmentObj.content || "";

      // Scanned pages without markup (or with only a hidden text layer of a few characters).
      // In reflowable books with real text, segmentObj.page is just an anchor map to the print edition.
      const scannedPages = (segmentObj.page || []).filter((page) => page.src);
      if (
        scannedPages.length > 0 &&
        !/<(?:img|svg|image)\b/i.test(segmentHtml) &&
        visibleText(segmentHtml).length <= 50
      ) {
        const chapters = await this.pageImageChapters(scannedPages, fileStem, chapterTitle || label, aesKey);
        return { chapters, missing: chapters.length === 0 };
      }

      if (!hasReadableContent(segmentHtml)) {
        logger.debug(`Segment ${label} has no content (not part of the readable preview).`);
        return { chapters: [], missing: true };
      }

      // Clean segment CSS for standard reader compatibility
      let segmentCss = this.cleanSegmentCss(await this.segmentCss(segmentObj, segment, aesKey), isFixedLayout);

      logger.debug(`Decrypted segment ${label} (${segmentHtml.length} chars). Downloading images...`);

      // Download original-resolution images, store them in the zip and point references at them
      ({ html: segmentHtml, css: segmentCss } = await this.embedResources(segmentHtml, segmentCss, aesKey));

      // In reflowable mode, format full-page illustrations with proper page-break styles
      if (!isFixedLayout) {
        segmentHtml = this.formatReflowableIllustrations(segmentHtml);
      }

      return {
        chapters: [{
          label: fileStem,
          title: chapterTitle || label,
          xhtml: segmentHtml, // wrapped into a document once the book language is known
          css: segmentCss,
        }],
        missing: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`\nFailed to download/decrypt segment ${label}: ${msg}`);
      return { chapters: [], missing: false };
    }
  }

  /**
   * Gives every segment a unique, filesystem- and XML-safe file stem.
   */
  static fileStems(segments: GoogleBookSegmentManifest[]): string[] {
    const used = new Set<string>();
    return segments.map((segment, i) => {
      const base = (segment.label || `segment-${i + 1}`).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "") || `segment-${i + 1}`;
      let stem = base;
      for (let n = 2; used.has(stem.toLowerCase()) || ["cover", "nav", "toc"].includes(stem.toLowerCase()); n++) {
        stem = `${base}-${n}`;
      }
      used.add(stem.toLowerCase());
      return stem;
    });
  }

  /**
   * Points `href="#id"` links at the chapter that actually contains the id,
   * and builds the TOC from the manifest's toc_entry list.
   */
  static linkChapters(
    segmentChapters: Chapter[][], // per manifest segment, in segment order
    manifest: GoogleBookManifest,
  ): { chapters: Chapter[]; tocItems: TocItem[] } {
    const chapters = segmentChapters.flat();
    const idToFile = new Map<string, string>();
    for (const chapter of chapters) {
      for (const id of collectIds(chapter.xhtml)) {
        if (!idToFile.has(id)) idToFile.set(id, `${chapter.label}.xhtml`);
      }
    }

    const linked: Chapter[] = [];
    for (const chapter of chapters) {
      const own = `${chapter.label}.xhtml`;
      const xhtml = rewriteFragmentLinks(chapter.xhtml, (id) => {
        const file = idToFile.get(id);
        if (!file) return null;
        return file === own ? `#${id}` : `${file}#${id}`;
      });
      linked.push({ ...chapter, xhtml });
    }

    const tocItems: TocItem[] = [];
    for (const entry of manifest.toc_entry || []) {
      const position = entry.reading_position;
      let href = position && idToFile.get(position) ? `${idToFile.get(position)}#${position}` : "";
      if (!href && entry.segment_index !== undefined) {
        const chapter = segmentChapters[entry.segment_index]?.[0];
        if (chapter) href = `${chapter.label}.xhtml`;
      }
      if (!href) continue;
      tocItems.push({ title: unescapeHtml(entry.label || "").trim() || "Untitled", href, depth: entry.depth || 0 });
    }

    return { chapters: linked, tocItems };
  }

  /**
   * Core download runner for EPUB.
   */
  async run(): Promise<void> {
    const { html, manifest } = await withSpinner("Fetching book details...", async () => {
      const htmlText = await this.getBookHtml();
      const manifestData = await this.getManifest();
      return { html: htmlText, manifest: manifestData };
    });
    const aesKey = this.getKey(html);
    const metadata = manifest.metadata || {};

    if (!manifest.segment || manifest.segment.length === 0) {
      throw new Error("This book does not contain reflowable text segments (EPUB format is unavailable). Try downloading as PDF.");
    }

    const isPreview = Boolean(metadata.preview && metadata.preview !== "full");
    if (isPreview) {
      logger.warn(`The book metadata indicates preview mode ('${metadata.preview}'). Only the preview segments will be included.`);
    }

    const missingLinks = manifest.segment.filter((segment) => !segment.link);
    if (missingLinks.length > 0) {
      const pct = ((missingLinks.length / manifest.segment.length) * 100).toFixed(2);
      const listStr = logger.showDebug
        ? ` List of missing segments: [${missingLinks.map(segment => segment.label).join(", ")}].`
        : "";
      logger.warn(`Could not find a download link for ${missingLinks.length} text segments (${pct}% missing, total: ${manifest.segment.length}).${listStr}${isPreview ? "" : " You might need to update your cookies."}`);
    }

    const title = unescapeHtml(metadata.title || metadata.volume_title || "Untitled");
    const safeTitle = safeName(title);
    const epubFilename = `${safeTitle}.epub`;

    this.prepareOutputDir(safeTitle);
    const outputPath = path.join(this.bookOutputDir, epubFilename);

    if (fs.existsSync(outputPath)) {
      logger.success(`Book already exists in downloads: ${outputPath}`);
      return;
    }

    const authors = metadata.authors || metadata.author || metadata.creator || "Unknown Author";
    const pub_date = metadata.pub_date || metadata.pubDate || metadata.date || metadata.publication_date || new Date().getFullYear().toString();
    const publisher = unescapeHtml(metadata.publisher || "Unknown Publisher");
    const segments = manifest.segment;

    logger.step(`Processing book: ${title}`);
    logger.info(`Authors     : ${Array.isArray(authors) ? authors.join(", ") : unescapeHtml(authors)}`);
    logger.info(`Published   : ${pub_date}`);
    logger.info(`Segments    : ${segments.length}`);
    logger.info(`Publisher   : ${publisher}`);

    this.resetResources();

    // Try downloading the cover
    const cover = await this.downloadCover(manifest, aesKey);

    if (segments.every((segment) => !segment.link)) {
      throw new Error("No accessible text segments with download links found. Please check your account ownership and cookies.");
    }

    // Detect fixed-layout (manga/comics) vs reflowable text (novels/standard books).
    // Books made only of scanned pages are switched to fixed layout once downloaded.
    let isFixedLayout = segments.some(
      (segment) => segment.fixed_layout_version || segment.text_properties?.fixed_layout_version
    );

    let viewport: { width: string | number; height: string | number } | undefined;
    if (isFixedLayout) {
      for (const segment of segments) {
        const vp = segment.text_properties?.fixed_layout_info?.viewport;
        if (vp?.width && vp?.height) {
          viewport = { width: vp.width, height: vp.height };
          break;
        }
      }
    }

    const isRightToLeft = Boolean(manifest.is_right_to_left);
    const fileStems = EpubDownloader.fileStems(segments);

    logger.step(`Downloading and decrypting ${segments.length} text segments...`);
    const concurrency = this.options.concurrency || 1;
    let completedCount = 0;

    const results: SegmentResult[] = await concurrentMap(
      segments,
      concurrency,
      async (segment, idx) => {
        const { chapters, missing } = await this.downloadAndProcessSegment(
          segment,
          fileStems[idx],
          aesKey,
          isFixedLayout,
          viewport
        );
        completedCount++;
        const chapterTitle = chapters[0]?.title;
        const displayTitle = chapterTitle && chapterTitle !== segment.label ? ` (${chapterTitle})` : "";
        const pagesInfo = chapters.length > 1 ? ` [${chapters.length} pages]` : "";
        logger.progress(completedCount, segments.length, `Segment ${segment.label}${displayTitle}${pagesInfo}`);

        if (concurrency <= 1 && this.options.pace > 0 && completedCount < segments.length) {
          await delay(this.options.pace);
        }

        return { index: idx, chapters, missing };
      },
    );
    logger.clearProgress();

    const missingCount = results.filter((r) => r.missing).length;
    const failedCount = results.filter((r) => !r.chapters.length && !r.missing).length;
    if (missingCount > 0) {
      logger.warn(`${missingCount}/${segments.length} segments have no content${isPreview ? " (outside the preview)" : ""} and were left out.`);
    }
    if (failedCount > 0) {
      logger.warn(`${failedCount} segments failed to download and were left out.`);
    }
    const allChapters = results.flatMap((r) => r.chapters);
    if (!allChapters.length) {
      throw new Error("None of the segments could be downloaded.");
    }

    // A book made only of scanned pages ("Original pages" edition) becomes a
    // fixed-layout EPUB, one page per document, sized to the scans.
    const scanOnly = allChapters.every((chapter) => chapter.pageImage);
    if (scanOnly && !isFixedLayout) {
      isFixedLayout = true;
      logger.info(`Book has scanned pages only (${allChapters.length} pages); building a fixed-layout EPUB.`);
    }
    if (scanOnly && !viewport) {
      const first = allChapters[0].pageImage!;
      viewport = { width: first.width, height: first.height };
    }

    // Google's manifest often reports "en" for translated books; trust the text when it disagrees.
    let language = manifest.language || metadata.language || "en";
    const guessed = guessLanguage(allChapters.map((chapter) => visibleText(chapter.xhtml)).join(" "));
    if (guessed && guessed !== language.split("-")[0]) {
      logger.info(`Language    : ${guessed} (manifest says '${language}', detected from the text)`);
      language = guessed;
    } else {
      logger.info(`Language    : ${language}`);
    }

    const { chapters: linkedChapters, tocItems } = EpubDownloader.linkChapters(
      results.map((r) => r.chapters),
      manifest,
    );
    const chapters = linkedChapters.map((chapter) => {
      const page = chapter.pageImage;
      return {
        ...chapter,
        css: page ? EpubDownloader.pageImageCss(page.width, page.height, isFixedLayout) : chapter.css,
        xhtml: this.linkStylesheet(chapter.xhtml, chapter.label, chapter.title, page ?? viewport, isFixedLayout, language),
      };
    });

    // Don't show the cover twice when it's the same picture as the first scanned page.
    const omitCoverPage = Boolean(cover && chapters[0]?.pageImage && (await this.isSameImage(cover.data, chapters[0].xhtml)));
    let bookCover = cover;
    if (omitCoverPage) {
      // The first page is the original-size scan; the cover download may be an upscaled copy.
      const src = chapters[0].xhtml.match(/<img\b[^>]*\bsrc="([^"]+)"/i)?.[1];
      const firstPage = this.epubImages.find((image) => image.filename === src);
      if (firstPage) bookCover = { data: firstPage.data, mimeType: firstPage.mimeType };
    }

    if (!isFixedLayout && this.options.pageIllustrations !== false && hasPageEdition(manifest)) {
      const upgradedCover = await this.upgradeIllustrations(manifest, aesKey, chapters, bookCover);
      if (upgradedCover) bookCover = upgradedCover;
    }

    logger.step("Assembling EPUB book archive...");

    const epubMetadata = {
      title,
      authors: Array.isArray(authors)
        ? authors
        : typeof authors === "string"
        ? unescapeHtml(authors).split(",").map((author: string) => author.trim()).filter(Boolean)
        : ["Unknown Author"],
      publisher: publisher || "Unknown Publisher",
      pubDate: pub_date || new Date().getFullYear().toString(),
      language,
      volumeId: this.bookId,
      isRightToLeft,
      isFixedLayout,
      viewport,
      tocItems,
      omitCoverPage,
    };

    await buildEpub(outputPath, epubMetadata, chapters, bookCover, this.epubImages);

    logger.success(`EPUB saved successfully: ${outputPath} (${chapters.length} chapters, ${this.epubImages.length} images)`);

    this.saveMetadata(metadata, title);
    this.cleanup();
  }
}
