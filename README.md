# google-play-book-downloader

A command-line tool to download and decrypt Google Play Books **you own** into EPUB, CBZ or PDF. Written in TypeScript for [Bun](https://bun.sh).

- **Light novels and other text books → EPUB**: the flowing-text edition, with every illustration at its original resolution — and, when Google also offers the print ("Original pages") edition, illustrations and cover upgraded from it (typically ~2x sharper).
- **Manga, comics and scanned books → CBZ** (or PDF): each page from its best source — the publisher's original image for manga pages, the stored scan at its native size for scanned books.
- The format is picked automatically; `--format` overrides it.

## Setup

Install [Bun](https://bun.sh), then:

```bash
git clone <this repository>
cd google-play-book-downloader
bun install
```

Export your Google Play session to the project folder, either as:

- `cookies.txt` — Netscape format, from a "cookies.txt" browser extension, or
- `curl.txt` — open a book at `play.google.com/books`, then in DevTools → Network right-click a request → *Copy as cURL*.

Use a browser profile or window you then close **without signing out**: signing out invalidates the exported session. The tool refreshes the short-lived `NID` cookie by itself, so you only need to export again when the login session itself ends (sign-out, password change, or Google expiring it).

## Usage

```bash
# Format picked automatically: EPUB for text books, CBZ for manga/scans, PDF for page-only books
bun start BOOK_ID

# Force a format
bun start BOOK_ID --format pdf --verbose
```

The book ID is the `id` in the reader URL: `https://play.google.com/books/reader?id=BOOK_ID`. Books are saved to `./downloads/<title>/`.

For a book you only have a preview of, only the preview pages/segments are included; segments outside the preview are left out instead of producing empty pages.

### Options

- `-f, --format <format>`: `auto` (default), `epub`, `cbz` or `pdf`
- `-c, --cookies <path>`: session file (default `./cookies.txt`, falls back to `./curl.txt`)
- `-o, --output <dir>`: output directory (default `./downloads`)
- `-t, --temp <dir>`: temporary/cache directory (default `./temp`)
- `-p, --pace <ms>`: delay between requests when `--concurrency 1` (default `50`)
- `-n, --concurrency <n>`: parallel downloads (default `4`)
- `--cover <source>`: `auto` (default), `frontcover`, a page ID (`PP1`, `PA1`…), a local image path, or `none`
- `--no-page-illustrations`: EPUB only — keep the EPUB's own images instead of upgrading them from the "Original pages" edition
- `-m, --metadata-only`: save metadata (and the TOC for PDF) without downloading the book
- `-v, --verbose`: debug output

#### How `--format auto` decides

| Book | Format |
|---|---|
| Fixed-layout (manga, comics) | CBZ |
| Scanned pages only | CBZ |
| Flowing text (with or without a page edition) | EPUB |
| Page images only, no text segments | PDF |

#### Cover selection (`--cover auto`)

The book's first page is compared with the store cover by perceptual hash. If they are the same picture, the book's own page is kept (it is the publisher's file, often lossless) unless the store cover is at least 1.5x larger; if they differ, the store cover is added in front.

### Upgrading the images of an existing EPUB (`hires`)

For a DRM-free EPUB you already have (e.g. one made by an older version of this tool), `hires` downloads the original illustrations from the Play Books reader and swaps them in. Images are paired by perceptual hash (and by file name when the publisher's names survive) and only replaced when the new image is larger.

```bash
bun start hires run --epub "book.epub" [--id BOOK_ID]    # fetch + replace; the ID is detected from the EPUB when possible
bun start hires fetch --id BOOK_ID                       # -> ./hires_work/BOOK_ID/{images,images.json}
bun start hires replace --epub "book.epub" --images ./hires_work/BOOK_ID --dry-run
bun start hires inspect --epub "book.epub"               # list images, sizes and reading order
```

The result goes to `<epub folder>/hires/<title>.epub` (or `--out`); the source EPUB is never modified, and the output is only written after it validates. Options: `--min-gain` (default `1.1`), `--max-dist` (default `0.2`), `--report report.json`, `--overwrite`.

## How it works

1. **Session**: cookies from `cookies.txt`/`curl.txt`; the fresh `NID` the reader page sets is kept for every later request (the decryption key is tied to it).
2. **Key**: the reader page embeds an obfuscated payload from which the 16-byte AES key is recovered.
3. **Manifest**: lists the text segments, the page images, the TOC and which editions exist.
4. **EPUB**: segments are fetched with the web reader's own parameters (keeping original SVG artwork), decrypted (AES-128-CBC), and their images embedded at original size (the reader's `w`/`h` are dropped, which makes Google return the publisher's file). Cross-chapter links are re-pointed, the navigation is rebuilt hierarchically, and the language is corrected from the text when the manifest is wrong. Scanned segments become one fixed-layout page per scan.
5. **CBZ/PDF**: segments are read to find each page's best source; pages are decrypted and packaged (`ComicInfo.xml` with the right-to-left flag for manga; RTL spreads reordered in PDF).

## Development

```bash
bun run test                # unit tests (offline; uses tests/fixtures/test-cookies.txt)
NETWORK_TESTS=1 bun test    # also run the tests that call Google
bun run typecheck           # type check
```

### Project structure

- `src/cli.ts` — CLI, format detection and the `hires` command
- `src/downloader/` — `base.ts` (session, key, manifest), `epub.ts`, `page.ts` (shared by `cbz.ts` and `pdf.ts`)
- `src/hires/` — EPUB image upgrade: `fetch.ts`, `replace.ts`, `epub-reader.ts`, `image-hash.ts` (pHash/dHash matching)
- `src/utils/` — `play-api.ts` (segment/image requests, decryption), `xhtml.ts` (markup rewriting), `epub-builder.ts`, `page-illustrations.ts`, `image-compare.ts`, `format.ts`, `cookie.ts`, `crypto.ts`, `async.ts`, `logger.ts`, `text.ts`
- `tests/` — unit tests (Bun test runner)

## Credits

- [devnoname120/google-play-book-downloader](https://github.com/devnoname120/google-play-book-downloader) — the original Python tool (key recovery, page and segment decryption), AGPL-3.0.
- [kuchingneko28/google-play-book-downloader](https://github.com/kuchingneko28/google-play-book-downloader) — the TypeScript/Bun rewrite this project builds on (CLI, PDF/CBZ/EPUB downloaders), originally published under ISC.
- PlayBooks EPUB-Box — the approach for fetching original-resolution illustrations and matching them to EPUB images by perceptual hash.

## License

[AGPL-3.0](LICENSE), like the original Python project this tool is derived from.

Use it only for books you have bought, for your own reading, and in line with the laws where you live.
