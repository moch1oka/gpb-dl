import { cac } from 'cac';
import fs from 'fs';
import path from 'path';
import { EpubDownloader } from './downloader/epub';
import { PdfDownloader } from './downloader/pdf';
import { CbzDownloader } from './downloader/cbz';
import { GoogleBookManifest } from './types';
import { chooseFormat } from './utils/format';
import { getCookieHeader } from './utils/cookie';
import { fetchWithRetry } from './utils/async';
import { logger, intro, outro, withSpinner } from './utils/logger';

interface CliOptions {
  format: 'pdf' | 'epub' | 'cbz' | 'auto';
  cookies: string;
  output: string;
  temp: string;
  pace: string;
  concurrency: string;
  verbose: boolean;
  metadataOnly: boolean;
  cover: string;
  pageIllustrations: boolean;
}

/**
 * Automatically detects the format by inspecting the book manifest content.
 */
async function detectFormat(
  bookId: string,
  cookiesPath: string
): Promise<{ format: 'pdf' | 'epub' | 'cbz'; manifest: GoogleBookManifest }> {
  const cookieHeader = getCookieHeader(cookiesPath);
  const headers = {
    cookie: cookieHeader,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  };
  const url = `https://play.google.com/books/volumes/${bookId}/manifest?hl=en&source=ge-web-app`;

  const response = await fetchWithRetry(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch book manifest: ${response.statusText} (${response.status})`);
  }

  const manifest = (await response.json()) as GoogleBookManifest;
  const { format, reason } = chooseFormat(manifest);
  logger.info(`Auto format: ${format.toUpperCase()} (${reason})`);
  return { format, manifest };
}

/**
 * Resolves the session file: the given path, or ./curl.txt when the default cookies.txt is absent.
 */
function resolveCookiesPath(option: string): string {
  const cookiesPath = path.resolve(option);
  if (fs.existsSync(cookiesPath)) return cookiesPath;
  const curlPath = path.resolve('./curl.txt');
  if (option === './cookies.txt' && fs.existsSync(curlPath)) {
    logger.info(`Using cURL session file found at: ${curlPath}`);
    return curlPath;
  }
  logger.error(
    `Session file not found at: ${cookiesPath}\nPlease place cookies.txt (Netscape format) or curl.txt (cURL command) in this folder.`
  );
  process.exit(1);
}

interface HiresCliOptions {
  epub?: string;
  id?: string;
  images?: string;
  work: string;
  out?: string;
  cookies: string;
  pace: string;
  concurrency: string;
  limit: string;
  minGain: string;
  maxDist: string;
  allowSmaller: boolean;
  dryRun: boolean;
  report?: string;
  overwrite: boolean;
  verbose: boolean;
}

async function runHires(action: string, options: HiresCliOptions): Promise<void> {
  const { HiresFetcher } = await import('./hires/fetch');
  const { replaceImages, inspectEpub } = await import('./hires/replace');
  const { loadEpub } = await import('./hires/epub-reader');

  const requireEpub = (): string => {
    if (!options.epub) {
      logger.error('--epub <file> is required for this action.');
      process.exit(1);
    }
    return path.resolve(options.epub);
  };

  const fetchImages = async (volumeId: string): Promise<string> => {
    const workDir = path.resolve(options.work, volumeId);
    const fetcher = new HiresFetcher(volumeId, {
      cookiesPath: resolveCookiesPath(options.cookies),
      outputDir: workDir,
      tempDir: workDir,
      workDir,
      pace: parseInt(options.pace, 10) || 0,
      concurrency: Math.max(1, parseInt(options.concurrency, 10) || 1),
      limit: parseInt(options.limit, 10) || 0,
    });
    await fetcher.fetchImages();
    return workDir;
  };

  const replaceOptions = {
    out: options.out ? path.resolve(options.out) : undefined,
    minGain: parseFloat(options.minGain),
    maxDist: parseFloat(options.maxDist),
    dryRun: options.dryRun,
    report: options.report ? path.resolve(options.report) : undefined,
    allowSmaller: options.allowSmaller,
    overwrite: options.overwrite,
  };

  switch (action) {
    case 'inspect':
      await inspectEpub(requireEpub());
      return;
    case 'fetch':
      if (!options.id) {
        logger.error('--id <volume-id> is required for hires fetch.');
        process.exit(1);
      }
      await fetchImages(options.id);
      return;
    case 'replace':
      if (!options.images) {
        logger.error('--images <dir> is required for hires replace (the work dir written by hires fetch).');
        process.exit(1);
      }
      await replaceImages(requireEpub(), path.resolve(options.images), replaceOptions);
      return;
    case 'run': {
      const epub = requireEpub();
      let volumeId = options.id;
      if (!volumeId) {
        volumeId = (await loadEpub(epub, false)).volumeId;
        if (!volumeId) {
          logger.error('Cannot identify the volume ID from the EPUB; pass --id (the id in reader?id=...).');
          process.exit(1);
        }
        logger.info(`Volume ID from EPUB: ${volumeId}`);
      }
      const workDir = await fetchImages(volumeId);
      await replaceImages(epub, workDir, replaceOptions);
      return;
    }
    default:
      logger.error(`Unknown hires action '${action}'. Use: fetch, replace, run, inspect.`);
      process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled Rejection: ${msg}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const cli = cac('playbook');

  cli
    .command('hires <action>', 'Original-resolution illustrations: fetch | replace | run | inspect')
    .option('--epub <file>', 'Input EPUB (DRM-free) for replace / run / inspect')
    .option('--id <volume-id>', 'Play Books volume ID (the id in reader?id=...); run detects it from the EPUB if omitted')
    .option('--images <dir>', 'Work dir written by "hires fetch" (with images.json) for replace')
    .option('-w, --work <dir>', 'Work directory; images go to <work>/<volume-id>', { default: './hires_work' })
    .option('--out <file>', 'Output EPUB (default: <epub dir>/hires/<title>.epub)')
    .option('-c, --cookies <path>', 'Path to your cookies.txt or curl.txt file', { default: './cookies.txt' })
    .option('-p, --pace <ms>', 'Pacing delay in milliseconds between requests', { default: '50' })
    .option('-n, --concurrency <n>', 'Number of concurrent downloads', { default: '4' })
    .option('--limit <n>', 'Download at most n images (0 = all, for testing)', { default: '0' })
    .option('--min-gain <x>', 'Replace only when the new image has at least x times the pixels', { default: '1.1' })
    .option('--max-dist <d>', 'Max perceptual-hash distance, 0 = identical, 0.5 = unrelated', { default: '0.2' })
    .option('--allow-smaller', 'Replace even when the new image is not larger (not recommended)', { default: false })
    .option('--dry-run', 'Only print the match / replace plan, write nothing', { default: false })
    .option('--report <file>', 'Write the match report as JSON')
    .option('--overwrite', 'Overwrite an existing output EPUB', { default: false })
    .option('-v, --verbose', 'Enable verbose output logging', { default: false })
    .action(async (action: string, options: HiresCliOptions) => {
      logger.showDebug = options.verbose;
      intro(`Google Play Book Downloader — hires ${action}`);
      try {
        await runHires(action, options);
        outro('Done!');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Execution Failed: ${msg}`);
        process.exit(1);
      }
    });

  cli
    .command('[book-id]', 'Download Google Play Book by ID')
    .option('-f, --format <format>', 'Output format (auto, pdf, epub, or cbz)', { default: 'auto' })
    .option('-c, --cookies <path>', 'Path to your cookies.txt or curl.txt file', { default: './cookies.txt' })
    .option('-o, --output <dir>', 'Directory to save downloaded books', { default: './downloads' })
    .option('-t, --temp <dir>', 'Directory for caching temporary files', { default: './temp' })
    .option('-p, --pace <ms>', 'Pacing delay in milliseconds between requests (use 0 for fastest)', { default: '50' })
    .option('-n, --concurrency <n>', 'Number of concurrent downloads', { default: '4' })
    .option('-v, --verbose', 'Enable verbose output logging', { default: false })
    .option('-m, --metadata-only', 'Save metadata and TOC JSON only without downloading book content', { default: false })
    .option('--cover <source>', 'Cover source: auto (default), frontcover, page ID (e.g. PP1, PP2), or image path', { default: 'auto' })
    .option('--no-page-illustrations', 'EPUB: keep the EPUB images instead of taking sharper ones from the "Original pages" edition')
    .action(async (bookId: string | undefined, options: CliOptions) => {
      // If book-id is omitted, show the help menu
      if (!bookId) {
        cli.outputHelp();
        process.exit(0);
      }

      logger.showDebug = options.verbose;

      intro('Google Play Book Downloader');
      logger.info(`Book ID: ${bookId}`);

      // Resolve options paths
      const cookiesPath = resolveCookiesPath(options.cookies);
      const outputDir = path.resolve(options.output);
      const tempDir = path.resolve(options.temp);
      const paceMs = parseInt(options.pace, 10);
      const concurrency = parseInt(options.concurrency, 10);

      // Unix permission bits only; Windows always reports 0o666 and uses ACLs instead.
      const cookieStat = fs.statSync(cookiesPath);
      if (process.platform !== 'win32' && cookieStat.mode & 0o077) {
        const mode = cookieStat.mode & 0o777;
        logger.warn(
          `Cookies file is readable by others (permissions: ${mode.toString(8)}). Consider restricting it with: chmod 600 ${cookiesPath}`
        );
      }

      if (isNaN(paceMs) || paceMs < 0) {
        logger.error('Pacing delay must be a positive number.');
        process.exit(1);
      }

      if (isNaN(concurrency) || concurrency < 1) {
        logger.error('Concurrency must be a positive number.');
        process.exit(1);
      }

      // Register signal handlers for graceful temp cleanup
      const bookTempPath = path.join(tempDir, bookId);
      const cleanupOnSignal = () => {
        if (fs.existsSync(bookTempPath)) {
          fs.rmSync(bookTempPath, { recursive: true, force: true });
        }
        process.exit(0);
      };
      process.on('SIGINT', cleanupOnSignal);
      process.on('SIGTERM', cleanupOnSignal);

      let chosenFormat: 'pdf' | 'epub' | 'cbz' = 'pdf';
      let preFetchedManifest: GoogleBookManifest | undefined;

      try {
        if (options.format === 'auto') {
          const detected = await withSpinner('Auto-detecting optimal format...', () =>
            detectFormat(bookId, cookiesPath)
          );
          chosenFormat = detected.format;
          preFetchedManifest = detected.manifest;
        } else if (options.format === 'pdf' || options.format === 'epub' || options.format === 'cbz') {
          chosenFormat = options.format;
        } else {
          logger.error(`Invalid format '${options.format}'. Supported formats: pdf, epub, cbz, auto.`);
          process.exit(1);
        }

        const downloaderOptions = {
          cookiesPath,
          outputDir,
          tempDir,
          pace: paceMs,
          concurrency,
          verbose: options.verbose,
          interactive: false,
          manifest: preFetchedManifest,
          cover: options.cover,
          pageIllustrations: options.pageIllustrations !== false,
        };

        if (options.metadataOnly) {
          logger.info('Extracting metadata and Table of Contents only...');
          const downloader =
            chosenFormat === 'cbz'
              ? new CbzDownloader(bookId, downloaderOptions)
              : chosenFormat === 'pdf'
              ? new PdfDownloader(bookId, downloaderOptions)
              : new EpubDownloader(bookId, downloaderOptions);
          const html = await downloader.getBookHtml();
          const manifest = await downloader.getManifest();
          const metadata = manifest.metadata || {};
          const toc = downloader.getToc(html);
          const title = metadata.title || metadata.volume_title || 'Untitled';
          
          downloader.prepareOutputDir(title);
          downloader.saveMetadata(metadata, title);
          if (toc.length > 0 && downloader instanceof PdfDownloader) {
            downloader.saveToc(toc, title);
          }
          outro('Metadata extraction complete!');
          return;
        }

        if (chosenFormat === 'pdf') {
          const downloader = new PdfDownloader(bookId, downloaderOptions);
          await downloader.run();
        } else if (chosenFormat === 'cbz') {
          const downloader = new CbzDownloader(bookId, downloaderOptions);
          await downloader.run();
        } else {
          const downloader = new EpubDownloader(bookId, downloaderOptions);
          await downloader.run();
        }
        outro('Download completed successfully!');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Execution Failed: ${msg}`);
        process.exit(1);
      }
    });

  cli.help();
  cli.version('2.0.0');
  cli.parse();
}

main();
