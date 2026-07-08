/**
 * PMT:gold-haven — slugFromTemplate: defaultOutputPath's filename slug.
 * A shipped custom .tracetemplate (e.g. "memory-vm") passes its resolved
 * ABSOLUTE PATH as `template`, not a short name — verified live before this
 * fix existed: the recorded filename ballooned into a slugified copy of the
 * entire directory tree ("…-users-simonfortelny-git-instruments-mcp-server-
 * assets-allocvmtrackerauto3s-tracetemplate.trace").
 */
import { describe, it, expect } from "vitest";
import { slugFromTemplate } from "../src/core/recording.js";

describe("slugFromTemplate", () => {
  it("slugs a plain template name unchanged in behavior", () => {
    expect(slugFromTemplate("Time Profiler")).toBe("time-profiler");
    expect(slugFromTemplate("Swift Concurrency")).toBe("swift-concurrency");
  });

  it("slugs from the BASENAME of an absolute path, not the whole path", () => {
    const path = "/Users/simonfortelny/git/instruments-mcp-server/assets/AllocVMTrackerAuto3s.tracetemplate";
    expect(slugFromTemplate(path)).toBe("allocvmtrackerauto3s");
  });

  it("strips the extension, not just the directory", () => {
    expect(slugFromTemplate("/some/dir/My Custom Template.tracetemplate")).toBe("my-custom-template");
  });

  it("handles a relative path with a slash the same way", () => {
    expect(slugFromTemplate("assets/AllocVMTrackerAuto3s.tracetemplate")).toBe("allocvmtrackerauto3s");
  });

  it("a name with no path separator is never basename'd (avoids false positives on names with dots)", () => {
    expect(slugFromTemplate("com.example.MyTemplate")).toBe("com-example-mytemplate");
  });
});
