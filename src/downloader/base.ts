import fs from "fs";
import path from "path";
import { getCookieHeader, mergeSetCookies } from "../utils/cookie";
import { decipherKey } from "../utils/crypto";
import { fetchWithRetry } from "../utils/async";
import { safeName } from "../utils/text";
import { logger } from "../utils/logger";
import { GoogleBookManifest, GoogleBookMetadata, GoogleBookTocEntry } from "../types";

export interface DownloaderOptions {
  cookiesPath: string;
  outputDir: string;
  tempDir: string;
  pace: number;
  concurrency?: number;
  verbose?: boolean;
  interactive?: boolean;
  manifest?: GoogleBookManifest;
  cover?: string;
  pageIllustrations?: boolean; // EPUB: upgrade illustrations from the "Original pages" edition (default on)
}

export abstract class BaseDownloader {
  protected bookId: string;
  protected options: DownloaderOptions;
  protected bookTempDir: string;
  protected bookOutputDir: string;
  protected headers: Record<string, string>;
  protected cachedManifest?: GoogleBookManifest;
  protected metadata?: GoogleBookMetadata;

  constructor(bookId: string, options: DownloaderOptions) {
    this.bookId = bookId;
    this.options = options;
    this.bookTempDir = path.join(this.options.tempDir, this.bookId);
    this.bookOutputDir = this.options.outputDir;

    if (options.manifest) {
      this.cachedManifest = options.manifest;
    }

    // Initialize directories
    if (!fs.existsSync(this.bookOutputDir)) {
      fs.mkdirSync(this.bookOutputDir, { recursive: true });
    }
    if (!fs.existsSync(this.options.tempDir)) {
      fs.mkdirSync(this.options.tempDir, { recursive: true });
    }
    if (!fs.existsSync(this.bookTempDir)) {
      fs.mkdirSync(this.bookTempDir, { recursive: true });
    }

    // Load cookies and generate headers
    const cookieHeader = getCookieHeader(this.options.cookiesPath);
    this.headers = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      referer: "https://play.google.com/books",
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    };
  }

  async getBookHtml(): Promise<string> {
    const url = `https://play.google.com/books/reader?id=${this.bookId}&hl=en`;
    logger.debug(`Fetching book reader HTML from: ${url}`);
    const response = await fetchWithRetry(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch book reader HTML: ${response.statusText} (${response.status})`);
    }
    // The reader page hands out a fresh session cookie (NID) that the decryption key in this
    // page is tied to. Segments and pages requested with a stale NID from cookies.txt come back
    // encrypted with a different key, so keep the cookie for every later request.
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) {
      this.headers.cookie = mergeSetCookies(this.headers.cookie, setCookies);
      logger.debug(`Reader updated cookies: ${setCookies.map((c) => c.split("=")[0]).join(", ")}`);
    }
    const text = await response.text();
    logger.debug(`Successfully fetched reader HTML (${text.length} characters)`);
    return text;
  }

  async getManifest(): Promise<GoogleBookManifest> {
    if (this.cachedManifest) {
      logger.debug("Using cached manifest");
      return this.cachedManifest;
    }
    const url = `https://play.google.com/books/volumes/${this.bookId}/manifest?hl=en&source=ge-web-app`;
    logger.debug(`Fetching book manifest from: ${url}`);
    const response = await fetchWithRetry(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch book manifest: ${response.statusText} (${response.status})`);
    }
    const json = await response.json() as GoogleBookManifest;
    this.cachedManifest = json;
    logger.debug(`Manifest metadata: title="${json.metadata?.title}", segments=${json.segment?.length || 0}, pages=${json.page?.length || 0}`);
    return json;
  }

  /**
   * Downloads official frontcover asset from Google Play publisher images,
   * falling back to Google Books content endpoint with max width.
   */
  async downloadFrontcover(): Promise<{ data: Buffer; mimeType: string } | null> {
    // 1. Try Google Play publisher frontcover asset endpoint (exact retail front cover)
    try {
      const publisherUrl = `https://play.google.com/books/publisher/content/images/frontcover/${this.bookId}?fife=w99999999`;
      logger.info("Downloading book cover from Google Play publisher endpoint...");
      const response = await fetchWithRetry(publisherUrl, { headers: this.headers });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        // Filter out tiny default placeholders (typically <= 2000 bytes)
        if (arrayBuffer.byteLength > 2000) {
          const data = Buffer.from(arrayBuffer);
          let mimeType = response.headers.get("content-type") || "image/jpeg";
          if (data[0] === 0x89 && data[1] === 0x50) {
            mimeType = "image/png";
          } else if (data[0] === 0xFF && data[1] === 0xD8) {
            mimeType = "image/jpeg";
          }
          return { data, mimeType };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Could not fetch from publisher frontcover endpoint: ${msg}`);
    }

    // 2. Fall back to books.google.com frontcover endpoint (with fife=w99999999 for high-res)
    try {
      const coverUrl = `https://books.google.com/books/content?id=${this.bookId}&printsec=frontcover&img=1&zoom=3&fife=w99999999`;
      logger.info("Downloading book cover from Google Books content endpoint...");
      const response = await fetchWithRetry(coverUrl, { headers: this.headers });
      if (!response.ok) return null;

      let mimeType = response.headers.get("content-type") || "image/jpeg";
      const arrayBuffer = await response.arrayBuffer();
      const data = Buffer.from(arrayBuffer);
      if (data[0] === 0x89 && data[1] === 0x50) {
        mimeType = "image/png";
      } else if (data[0] === 0xFF && data[1] === 0xD8) {
        mimeType = "image/jpeg";
      }
      return { data, mimeType };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Failed to download frontcover: ${msg}`);
      return null;
    }
  }

  /**
   * Parses the Table of Contents from the HTML.
   */
  getToc(html: string): GoogleBookTocEntry[] {
    const match = html.match(/"toc_entry":\s*(\[[\s\S]*?}\s*])/);
    if (match) {
      try {
        const toc = JSON.parse(match[1]) as GoogleBookTocEntry[];
        logger.debug(`Parsed Table of Contents entries: ${toc.length}`);
        return toc;
      } catch (err) {
        // Fallback to empty array
      }
    }
    return [];
  }

  /**
   * Extracts and deciphers the AES decryption key.
   */
  getKey(html: string): Buffer {
    const match = html.match(/<body[\s\S]*?<[^>]+src\s*=\s*["']data:.*?base64,([^"']+)["']/);
    if (!match) {
      throw new Error("Could not find the base64-encoded decryption key in the HTML page. You might need to update your cookies.");
    }
    logger.debug(`Extracted Base64 Key ciphertext length: ${match[1].length}`);
    const raw = Buffer.from(match[1], "base64").toString("utf-8");
    const key = decipherKey(raw);
    logger.debug(`Deciphered AES Key (Hex): ${key.toString("hex")}`);
    return key;
  }

  log(message: string): void {
    logger.info(message);
  }

  logWarn(message: string): void {
    logger.warn(message);
  }

  logError(message: string): void {
    logger.error(message);
  }

  /**
   * Sets the book-specific output subdirectory and creates it.
   */
  public prepareOutputDir(safeTitle: string): void {
    const subdir = path.join(this.options.outputDir, safeName(safeTitle));
    if (!fs.existsSync(subdir)) {
      fs.mkdirSync(subdir, { recursive: true });
    }
    this.bookOutputDir = subdir;
  }

  /**
   * Saves book metadata as a JSON file alongside the output.
   */
  public saveMetadata(metadata: GoogleBookMetadata, title: string): void {
    const jsonPath = path.join(this.bookOutputDir, `${safeName(title)}_metadata.json`);
    const jsonData = JSON.stringify(metadata, null, 2);
    fs.writeFileSync(jsonPath, jsonData, "utf-8");
    logger.info(`Metadata saved to: ${jsonPath}`);
  }

  /**
   * Cleans up temporary files for this book.
   */
  protected cleanup(): void {
    try {
      logger.info("Cleaning up temporary files...");
      if (fs.existsSync(this.bookTempDir)) {
        fs.rmSync(this.bookTempDir, { recursive: true, force: true });
      }
      if (fs.existsSync(this.options.tempDir) && fs.readdirSync(this.options.tempDir).length === 0) {
        fs.rmSync(this.options.tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }

  /**
   * Main download runner.
   */
  abstract run(): Promise<void>;
}
