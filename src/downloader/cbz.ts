import fs from "fs";
import path from "path";
import archiver from "archiver";
import { DownloaderOptions } from "./base";
import { PageDownloader } from "./page";
import { logger, withSpinner } from "../utils/logger";
import { GoogleBookManifest, GoogleBookMetadata } from "../types";
import { safeName, unescapeHtml, escapeXml } from "../utils/text";
import { delay, concurrentMap } from "../utils/async";

/**
 * Builds ComicInfo.xml metadata conforming to ComicInfo schema 2.0/2.1.
 * Supported by Komga, Kavita, Mihon, Tachiyomi, Calibre, and Chunky.
 */
export function buildComicInfoXml(
  manifest: GoogleBookManifest,
  metadata: GoogleBookMetadata,
  totalPages: number
): string {
  const rawTitle = metadata.title || metadata.volume_title || "Untitled";
  const title = unescapeHtml(rawTitle);
  const authors = Array.isArray(metadata.authors)
    ? metadata.authors.map((a) => unescapeHtml(a)).join(", ")
    : metadata.authors
    ? unescapeHtml(metadata.authors)
    : "";
  const publisher = metadata.publisher ? unescapeHtml(metadata.publisher) : "";
  const pubDate =
    metadata.pub_date ||
    metadata.pubDate ||
    metadata.date ||
    metadata.publication_date ||
    "";

  let year = "";
  let month = "";
  let day = "";
  const dateMatch = pubDate.match(/^(\d{4})(?:[-./](\d{1,2}))?(?:[-./](\d{1,2}))?/);
  if (dateMatch) {
    year = dateMatch[1];
    month = dateMatch[2] ? String(parseInt(dateMatch[2], 10)) : "";
    day = dateMatch[3] ? String(parseInt(dateMatch[3], 10)) : "";
  }

  const isRtl = Boolean(manifest.is_right_to_left);

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Title>${escapeXml(title)}</Title>`,
    `  <Series>${escapeXml(title)}</Series>`,
  ];

  if (authors) {
    lines.push(`  <Writer>${escapeXml(authors)}</Writer>`);
  }
  if (publisher) {
    lines.push(`  <Publisher>${escapeXml(publisher)}</Publisher>`);
  }
  if (year) {
    lines.push(`  <Year>${escapeXml(year)}</Year>`);
  }
  if (month) {
    lines.push(`  <Month>${escapeXml(month)}</Month>`);
  }
  if (day) {
    lines.push(`  <Day>${escapeXml(day)}</Day>`);
  }
  lines.push(`  <PageCount>${totalPages}</PageCount>`);
  lines.push(`  <Manga>${isRtl ? "YesAndRightToLeft" : "No"}</Manga>`);
  lines.push("</ComicInfo>");

  return lines.join("\n");
}

export class CbzDownloader extends PageDownloader {
  constructor(bookId: string, options: DownloaderOptions) {
    super(bookId, options);
  }

  /**
   * Packages downloaded images into a Comic Book Zip (.cbz) file with ComicInfo.xml metadata.
   */
  async createCbz(
    imagePaths: string[],
    manifest: GoogleBookManifest,
    metadata: GoogleBookMetadata,
    title: string
  ): Promise<string> {
    const safeTitle = safeName(title);
    const cbzFilename = `${safeTitle}.cbz`;
    const outputPath = path.join(this.bookOutputDir, cbzFilename);

    const comicInfoXml = buildComicInfoXml(manifest, metadata, imagePaths.length);

    logger.step(`Packaging ${imagePaths.length} pages into CBZ...`);

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver("zip", {
        store: true,
        zlib: { level: 0 },
      });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);

      // Append ComicInfo.xml metadata file
      archive.append(comicInfoXml, { name: "ComicInfo.xml" });

      // Append image files with zero-padded names for consistent sorting in comic viewers
      const padLength = Math.max(3, String(imagePaths.length).length);
      for (let i = 0; i < imagePaths.length; i++) {
        const imagePath = imagePaths[i];
        const ext = path.extname(imagePath) || ".jpg";
        const entryName = `${String(i + 1).padStart(padLength, "0")}${ext}`;
        // append() with the bytes keeps archive order = page order; archive.file() reads
        // files asynchronously and can shuffle entries for readers that go by zip order.
        archive.append(fs.readFileSync(imagePath), { name: entryName });
      }

      archive.finalize();
    });

    return outputPath;
  }

  /**
   * Core download runner for CBZ.
   */
  async run(): Promise<void> {
    const { html, manifest } = await withSpinner("Fetching book details...", async () => {
      const htmlText = await this.getBookHtml();
      const manifestData = await this.getManifest();
      return { html: htmlText, manifest: manifestData };
    });
    const aesKey = this.getKey(html);
    const metadata = manifest.metadata || {};

    if (!manifest.page || manifest.page.length === 0) {
      throw new Error(
        "This book does not contain scanned pages (CBZ format is unavailable). Try downloading as EPUB."
      );
    }

    if (metadata.preview && metadata.preview !== "full") {
      logger.warn(`The book metadata indicates preview mode ('${metadata.preview}'). Downloading available pages...`);
    }

    const missingPages = manifest.page.filter((page) => !page.src);
    if (missingPages.length > 0) {
      const pct = ((missingPages.length / manifest.page.length) * 100).toFixed(2);
      const listStr = logger.showDebug
        ? ` List of missing pages: [${missingPages.map((page) => page.pid).join(", ")}].`
        : "";
      logger.warn(
        `Could not find a download link for ${missingPages.length} pages (${pct}% missing, total: ${manifest.page.length}).${listStr} You might need to update your cookies.`
      );
    }

    this.cachedFiles = new Set(fs.readdirSync(this.bookTempDir));

    const rawTitle = metadata.title || metadata.volume_title || "Untitled";
    const title = unescapeHtml(rawTitle);
    const safeTitle = safeName(title);
    const cbzFilename = `${safeTitle}.cbz`;

    this.prepareOutputDir(safeTitle);
    const outputPath = path.join(this.bookOutputDir, cbzFilename);

    if (fs.existsSync(outputPath)) {
      logger.success(`Book already exists in downloads: ${outputPath}`);
      return;
    }

    const authors = Array.isArray(metadata.authors)
      ? metadata.authors.map((a) => unescapeHtml(a)).join(", ")
      : metadata.authors
      ? unescapeHtml(metadata.authors)
      : metadata.author || metadata.creator || "Unknown Author";
    const pub_date =
      metadata.pub_date ||
      metadata.pubDate ||
      metadata.date ||
      metadata.publication_date ||
      new Date().getFullYear().toString();
    const publisher = metadata.publisher ? unescapeHtml(metadata.publisher) : "Unknown Publisher";
    const num_pages = metadata.num_pages || manifest.page?.length || 0;
    const pages = manifest.page;

    logger.step(`Processing book: ${title}`);
    logger.info(`Authors     : ${authors}`);
    logger.info(`Published   : ${pub_date}`);
    logger.info(`Total Pages : ${num_pages}`);
    logger.info(`Publisher   : ${publisher}`);
    if (manifest.is_right_to_left) {
      logger.info(`Manga Mode  : Right-to-Left (flagged in ComicInfo.xml)`);
    }

    const validPages = pages.filter((page) => page.src);
    if (validPages.length === 0) {
      throw new Error(
        "No accessible pages with download links found. Please check your account ownership and cookies."
      );
    }

    const sources = await this.resolvePageSources(manifest, aesKey);

    logger.step(`Downloading ${validPages.length} pages...`);
    const concurrency = this.options.concurrency || 1;

    let completedCount = 0;
    const imagePaths: string[] = await concurrentMap(
      validPages,
      concurrency,
      async (page) => {
        const { pid, src, order } = page;
        const imagePath = await this.downloadAndDecryptPage(
          src!,
          aesKey,
          pid,
          order,
          validPages.length,
          sources.get(pid)
        );
        completedCount++;
        logger.progress(completedCount, validPages.length, `Saved page ${pid}`);

        if (concurrency <= 1 && this.options.pace > 0 && completedCount < validPages.length) {
          await delay(this.options.pace);
        }

        return imagePath;
      }
    );
    logger.clearProgress();

    const finalImagePaths = await this.applyCoverSelection(imagePaths);

    const cbzPath = await this.createCbz(finalImagePaths, manifest, metadata, title);
    logger.success(`CBZ saved successfully: ${cbzPath}`);

    this.saveMetadata(metadata, title);
    this.cleanup();
  }
}
