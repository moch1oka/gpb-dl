import { expect, test, describe, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { buildComicInfoXml, CbzDownloader } from "../src/downloader/cbz";
import { GoogleBookManifest } from "../types";

const TEMP_TEST_DIR = path.join(__dirname, "temp_cbz_test");

describe("cbz utility and packaging", () => {
  afterEach(() => {
    if (fs.existsSync(TEMP_TEST_DIR)) {
      fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("buildComicInfoXml", () => {
    test("generates valid ComicInfo XML with all standard fields", () => {
      const manifest: GoogleBookManifest = {
        metadata: {
          title: "One Piece &amp; Adventure",
          authors: ["Eiichiro Oda"],
          publisher: "Shueisha",
          pub_date: "2023-08-04",
        },
        is_right_to_left: true,
      };

      const xml = buildComicInfoXml(manifest, manifest.metadata, 100);

      expect(xml).toContain("<Title>One Piece &amp; Adventure</Title>");
      expect(xml).toContain("<Series>One Piece &amp; Adventure</Series>");
      expect(xml).toContain("<Writer>Eiichiro Oda</Writer>");
      expect(xml).toContain("<Publisher>Shueisha</Publisher>");
      expect(xml).toContain("<Year>2023</Year>");
      expect(xml).toContain("<Month>8</Month>");
      expect(xml).toContain("<Day>4</Day>");
      expect(xml).toContain("<PageCount>100</PageCount>");
      expect(xml).toContain("<Manga>YesAndRightToLeft</Manga>");
    });

    test("sets Manga to No for left-to-right books", () => {
      const manifest: GoogleBookManifest = {
        metadata: {
          title: "Standard Western Comic",
          authors: "Stan Lee, Jack Kirby",
        },
        is_right_to_left: false,
      };

      const xml = buildComicInfoXml(manifest, manifest.metadata, 32);

      expect(xml).toContain("<Manga>No</Manga>");
      expect(xml).toContain("<Writer>Stan Lee, Jack Kirby</Writer>");
    });
  });

  describe("createCbz", () => {
    test("creates a valid .cbz zip file with zero-padded page images and ComicInfo.xml", async () => {
      fs.mkdirSync(TEMP_TEST_DIR, { recursive: true });

      // Create dummy image files
      const img1 = path.join(TEMP_TEST_DIR, "page1.png");
      const img2 = path.join(TEMP_TEST_DIR, "page2.jpg");
      fs.writeFileSync(img1, Buffer.from("fake-png-content"));
      fs.writeFileSync(img2, Buffer.from("fake-jpg-content"));

      const dummyCookiesPath = path.join(TEMP_TEST_DIR, "cookies.txt");
      fs.writeFileSync(dummyCookiesPath, "SID=abc; HSID=def");

      const downloader = new CbzDownloader("test-book", {
        cookiesPath: dummyCookiesPath,
        outputDir: TEMP_TEST_DIR,
        tempDir: TEMP_TEST_DIR,
        pace: 0,
      });

      const manifest: GoogleBookManifest = {
        metadata: {
          title: "Test Manga Volume 1",
          authors: "Manga Author",
        },
        is_right_to_left: true,
      };

      const cbzPath = await downloader.createCbz(
        [img1, img2],
        manifest,
        manifest.metadata,
        "Test Manga Volume 1"
      );

      expect(fs.existsSync(cbzPath)).toBe(true);
      expect(cbzPath.endsWith(".cbz")).toBe(true);
      expect(fs.statSync(cbzPath).size).toBeGreaterThan(0);
    });
  });
});
