import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TEST_COOKIES } from "./fixtures";
import { PageDownloader } from "../src/downloader/page";
import fs from "fs";
import path from "path";
import jpeg from "jpeg-js";

function createSolidJpeg(width: number, height: number, r: number, g: number, b: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  const raw = jpeg.encode({ data, width, height }, 90);
  return Buffer.from(raw.data);
}

class TestPageDownloader extends PageDownloader {
  async run(): Promise<void> {}

  // Allow mocking downloadFrontcover
  public mockFrontcover: { data: Buffer; mimeType: string } | null = null;
  override async downloadFrontcover() {
    return this.mockFrontcover;
  }
}

describe("PageDownloader applyCoverSelection", () => {
  const testDir = path.resolve("tmp/test_page_cover");

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("skips cover selection when --cover none is specified", async () => {
    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
      cover: "none",
    });

    const initialPaths = ["page1.jpg", "page2.jpg"];
    const result = await downloader.applyCoverSelection(initialPaths);
    expect(result).toEqual(initialPaths);
  });

  it("prepends local file when --cover points to existing image", async () => {
    const dummyPath = path.join(testDir, "custom_cover.jpg");
    fs.writeFileSync(dummyPath, createSolidJpeg(50, 50, 100, 100, 100));

    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
      cover: dummyPath,
    });

    const initialPaths = ["page1.jpg", "page2.jpg"];
    const result = await downloader.applyCoverSelection(initialPaths);
    expect(result).toEqual([dummyPath, "page1.jpg", "page2.jpg"]);
  });

  it("moves specified page ID to index 0 when --cover <pid> is passed", async () => {
    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
      cover: "PP2",
    });

    const initialPaths = ["path/to/PP1.jpeg", "path/to/PP2.jpeg", "path/to/PP3.jpeg"];
    const result = await downloader.applyCoverSelection(initialPaths);
    expect(result[0]).toBe("path/to/PP2.jpeg");
    expect(result.length).toBe(3);
  });

  it("prepends store cover when first page differs in content", async () => {
    const page0Path = path.join(testDir, "diff_page0.jpg");
    fs.writeFileSync(page0Path, createSolidJpeg(100, 100, 0, 0, 0)); // Black

    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: testDir,
      pace: 0,
      cover: "auto",
    });

    // Mock store cover (White)
    downloader.mockFrontcover = {
      data: createSolidJpeg(100, 100, 255, 255, 255),
      mimeType: "image/jpeg",
    };

    const result = await downloader.applyCoverSelection([page0Path, "page1.jpg"]);
    expect(result.length).toBe(3);
    expect(result[0]).toContain("cover.jpeg");
    expect(result[1]).toBe(page0Path);
  });

  it("keeps first page when first page matches store cover and has higher resolution", async () => {
    const page0Path = path.join(testDir, "same_page0.jpg");
    fs.writeFileSync(page0Path, createSolidJpeg(200, 200, 120, 120, 120)); // 200x200

    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: testDir,
      pace: 0,
      cover: "auto",
    });

    // Mock store cover (100x100 same content)
    downloader.mockFrontcover = {
      data: createSolidJpeg(100, 100, 120, 120, 120),
      mimeType: "image/jpeg",
    };

    const result = await downloader.applyCoverSelection([page0Path, "page1.jpg"]);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(page0Path);
  });

  it("keeps a PNG first page over a same-size store cover", async () => {
    const page0Path = path.join(testDir, "png_page0.png");
    const sharp = (await import("sharp")).default;
    fs.writeFileSync(page0Path, await sharp(createSolidJpeg(300, 450, 90, 140, 200)).png().toBuffer());

    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: testDir,
      pace: 0,
      cover: "auto",
    });
    downloader.mockFrontcover = { data: createSolidJpeg(300, 450, 90, 140, 200), mimeType: "image/jpeg" };

    const result = await downloader.applyCoverSelection([page0Path, "page1.jpg"]);
    expect(result).toEqual([page0Path, "page1.jpg"]);
  });

  it("frontcover mode replaces (not duplicates) a matching PNG first page", async () => {
    const page0Path = path.join(testDir, "png_page0_fc.png");
    const sharp = (await import("sharp")).default;
    fs.writeFileSync(page0Path, await sharp(createSolidJpeg(300, 450, 90, 140, 200)).png().toBuffer());

    const downloader = new TestPageDownloader("test_book", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: testDir,
      pace: 0,
      cover: "frontcover",
    });
    downloader.mockFrontcover = { data: createSolidJpeg(300, 450, 90, 140, 200), mimeType: "image/jpeg" };

    const result = await downloader.applyCoverSelection([page0Path, "page1.jpg"]);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("cover.jpeg");
  });
});
