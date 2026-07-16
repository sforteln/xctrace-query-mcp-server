/**
 * PMT:serene-wind — config.ts's recordingsDir field. Mocks node:fs/promises
 * so this never touches the real ~/Library/Application Support/xctrace-query-mcp-server/
 * config.json on the machine running the test (config.ts has no path-
 * injection seam — configPath() is hardcoded to the real homedir()).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
}));

const { loadConfig, defaultRecordingsDir } = await import("../src/config.js");

describe("defaultRecordingsDir", () => {
  it("returns a path under xctrace-query-mcp-server's Application Support directory, ending in 'recordings'", () => {
    const dir = defaultRecordingsDir();
    expect(dir).toMatch(/xctrace-query-mcp-server[\\/]recordings$/);
  });
});

describe("loadConfig recordingsDir parsing", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("defaults to null when the config file is missing", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const config = await loadConfig();
    expect(config.recordingsDir).toBeNull();
  });

  it("defaults to null when recordingsDir is absent from a valid config file", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ searchRoots: ["/some/dir"] }));
    const config = await loadConfig();
    expect(config.recordingsDir).toBeNull();
  });

  it("parses a configured recordingsDir string", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ recordingsDir: "/Volumes/External/traces" }));
    const config = await loadConfig();
    expect(config.recordingsDir).toBe("/Volumes/External/traces");
  });

  it("defaults to null when recordingsDir is present but not a string (malformed)", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ recordingsDir: 42 }));
    const config = await loadConfig();
    expect(config.recordingsDir).toBeNull();
  });
});
