/**
 * PMT:ash-lagoon — list_processes must surface zombie/defunct status so the
 * AI doesn't guess a dead PID when attach's own docstring warning wasn't
 * enough (verified live: an xcodeAI session picked the dead one of two
 * candidate PIDs and wasted a round-trip).
 */
import { describe, it, expect } from "vitest";
import { statusFromStat, parsePsOutput } from "../src/core/listProcesses.js";

describe("statusFromStat", () => {
  it("maps every documented ps STAT leading character to a readable label", () => {
    expect(statusFromStat("R")).toBe("running");
    expect(statusFromStat("R+")).toBe("running");
    expect(statusFromStat("S")).toBe("sleeping");
    expect(statusFromStat("Ss")).toBe("sleeping");
    expect(statusFromStat("I")).toBe("idle");
    expect(statusFromStat("T")).toBe("stopped");
    expect(statusFromStat("U")).toBe("waiting");
    expect(statusFromStat("Z")).toBe("zombie");
  });

  it("falls back to unknown for an unrecognized or missing code rather than throwing", () => {
    expect(statusFromStat("?")).toBe("unknown");
    expect(statusFromStat(undefined)).toBe("unknown");
    expect(statusFromStat("")).toBe("unknown");
  });
});

const HEADER = "  PID USER     STAT ARGS";
const ME = "simon";

function psLine(pid: number, user: string, stat: string, command: string): string {
  return `${pid} ${user} ${stat} ${command}`;
}

describe("parsePsOutput", () => {
  it("labels a live process as running and a zombie as zombie, with a note only on the zombie", () => {
    const stdout = [
      HEADER,
      psLine(111, ME, "S", "/Applications/MyApp.app/Contents/MacOS/MyApp"),
      psLine(222, ME, "Z", "/Applications/MyApp.app/Contents/MacOS/MyApp"),
    ].join("\n");

    const result = parsePsOutput(stdout, { currentUser: ME });
    const live = result.find((p) => p.pid === 111)!;
    const dead = result.find((p) => p.pid === 222)!;

    expect(live.status).toBe("sleeping");
    expect(live.note).toBeUndefined();
    expect(dead.status).toBe("zombie");
    expect(dead.note).toMatch(/cannot be attached to and cannot be killed/);
  });

  it("without a search term, only lists the current user's non-system processes", () => {
    const stdout = [
      HEADER,
      psLine(1, "root", "Ss", "/sbin/launchd"),
      psLine(2, "root", "S", "/usr/libexec/something"),
      psLine(333, ME, "S", "/Applications/MyApp.app/Contents/MacOS/MyApp"),
      psLine(444, "otheruser", "S", "/Applications/OtherApp.app/Contents/MacOS/OtherApp"),
    ].join("\n");

    const result = parsePsOutput(stdout, { currentUser: ME });
    expect(result.map((p) => p.pid)).toEqual([333]);
  });

  it("with a search term, matches any user's command case-insensitively and ignores the user/system-prefix filter", () => {
    const stdout = [
      HEADER,
      psLine(1, "root", "Ss", "/sbin/launchd"),
      psLine(555, "otheruser", "S", "/Applications/MyApp.app/Contents/MacOS/MyApp"),
      psLine(666, ME, "S", "/Applications/Unrelated.app/Contents/MacOS/Unrelated"),
    ].join("\n");

    const result = parsePsOutput(stdout, { currentUser: ME, search: "myapp" });
    expect(result.map((p) => p.pid)).toEqual([555]);
  });

  it("excludes xctrace and the server's own process from results", () => {
    const stdout = [
      HEADER,
      psLine(1, ME, "R", "/usr/bin/xcrun xctrace record --foo"),
      psLine(2, ME, "R", "node /path/to/xctrace-query-mcp-server/dist/index.js"),
      psLine(333, ME, "S", "/Applications/MyApp.app/Contents/MacOS/MyApp"),
    ].join("\n");

    const result = parsePsOutput(stdout, { currentUser: ME });
    expect(result.map((p) => p.pid)).toEqual([333]);
  });

  it("extracts the bare executable name from the full command path", () => {
    const stdout = [HEADER, psLine(333, ME, "S", "/Applications/MyApp.app/Contents/MacOS/MyApp --flag")].join("\n");
    const result = parsePsOutput(stdout, { currentUser: ME });
    expect(result[0].name).toBe("MyApp");
    expect(result[0].command).toBe("/Applications/MyApp.app/Contents/MacOS/MyApp --flag");
  });
});
