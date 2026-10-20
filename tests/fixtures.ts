import path from "path";

/**
 * A fake session file, so downloaders can be constructed without a real cookies.txt
 * (which is git-ignored and never available in CI).
 */
export const TEST_COOKIES = path.join(import.meta.dir, "fixtures", "test-cookies.txt");

/**
 * Tests that call Google's servers only run when NETWORK_TESTS is set:
 *   NETWORK_TESTS=1 bun test
 */
export const RUN_NETWORK_TESTS = Boolean(process.env.NETWORK_TESTS);
