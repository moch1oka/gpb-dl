import { expect, test, test as it, describe, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { getCookieHeader, mergeSetCookies } from "../src/utils/cookie";

const TEMP_COOKIE_FILE = path.join(__dirname, "temp_cookies_test.txt");

describe("cookie utility", () => {
  afterEach(() => {
    if (fs.existsSync(TEMP_COOKIE_FILE)) {
      fs.unlinkSync(TEMP_COOKIE_FILE);
    }
  });

  test("throws if file does not exist", () => {
    expect(() => getCookieHeader("nonexistent_file.txt")).toThrow(/Cookies file not found/);
  });

  test("throws if no valid cookies are found", () => {
    fs.writeFileSync(TEMP_COOKIE_FILE, "# Netscape HTTP Cookie File\n");
    expect(() => getCookieHeader(TEMP_COOKIE_FILE)).toThrow(/No valid cookies found/);
  });

  test("successfully parses valid Netscape cookies", () => {
    const data = [
      "# Netscape HTTP Cookie File",
      ".google.com\tTRUE\t/\tTRUE\t2147483647\tSID\tmy_sid_value",
      ".google.com\tTRUE\t/\tTRUE\t2147483647\tHSID\tmy_hsid_value",
      "invalid_line_without_tabs",
      ".google.com\tTRUE\t/\tTRUE\t2147483647\tBAD_CHAR\tvalue_with_\xff_bad_char"
    ].join("\n");

    fs.writeFileSync(TEMP_COOKIE_FILE, data);

    const header = getCookieHeader(TEMP_COOKIE_FILE);
    expect(header).toBe("SID=my_sid_value; HSID=my_hsid_value");
  });

  test("successfully parses cURL command with -H cookie (POSIX/bash)", () => {
    const curlCmd = `curl 'https://play.google.com/books' -H 'cookie: SID=session_1; HSID=session_2' -H 'user-agent: Mozilla/5.0'`;
    fs.writeFileSync(TEMP_COOKIE_FILE, curlCmd);

    const header = getCookieHeader(TEMP_COOKIE_FILE);
    expect(header).toBe("SID=session_1; HSID=session_2");
  });

  test("successfully parses cURL command with Windows cmd carets", () => {
    const curlCmd = `curl ^"https://play.google.com/books^" ^\r\n  -H ^"Cookie: SID=win_session; HSID=win_hsid^"`;
    fs.writeFileSync(TEMP_COOKIE_FILE, curlCmd);

    const header = getCookieHeader(TEMP_COOKIE_FILE);
    expect(header).toBe("SID=win_session; HSID=win_hsid");
  });

  test("successfully parses cURL command with -b argument", () => {
    const curlCmd = `curl 'https://play.google.com/books' -b 'SID=b_val; SSID=ssid_val'`;
    fs.writeFileSync(TEMP_COOKIE_FILE, curlCmd);

    const header = getCookieHeader(TEMP_COOKIE_FILE);
    expect(header).toBe("SID=b_val; SSID=ssid_val");
  });

  test("successfully parses raw cookie string", () => {
    fs.writeFileSync(TEMP_COOKIE_FILE, "SID=raw_sid; HSID=raw_hsid");

    const header = getCookieHeader(TEMP_COOKIE_FILE);
    expect(header).toBe("SID=raw_sid; HSID=raw_hsid");
  });
});

describe("mergeSetCookies", () => {
  it("replaces every cookie of a re-set name and keeps the rest", () => {
    const header = "SID=abc; NID=old1; HSID=x; NID=old2";
    const merged = mergeSetCookies(header, ["NID=fresh; expires=Wed, 21 Apr 2027 00:00:00 GMT; path=/; domain=.google.com; HttpOnly"]);
    expect(merged).toBe("SID=abc; HSID=x; NID=fresh");
  });

  it("drops cookies the server deletes and ignores empty input", () => {
    expect(mergeSetCookies("A=1; B=2", ["B=gone; Max-Age=0; path=/"])).toBe("A=1");
    expect(mergeSetCookies("A=1", [])).toBe("A=1");
  });
});
