// Report a Problem… and Send Feedback…: the new GitHub issue's address
// (src/shared/feedback.ts), built from the update feed's repository and four
// details of this build and this Mac, and opened by main only when it is a new
// issue of that repository (src/main/feedback.ts). Nothing else goes in it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import {
  chipFamily,
  feedbackDetailLines,
  feedbackFoot,
  feedbackIssueUrl,
  feedbackMenuLabels,
  isFeedbackIssueUrl,
  isFeedbackKind,
  maxFeedbackUrlLength,
  type FeedbackDetails,
} from "../src/shared/feedback";
import { isSafeExternalUrl } from "../src/shared/external-url";

const { feedbackDetails, feedbackRepo, openFeedbackIssue } = await import("../src/main/feedback");
const { UPDATE_GITHUB_FEED } = await import("../src/main/updates");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const details: FeedbackDetails = { version: "0.1.1", signedRelease: true, macOS: "15.1.0", chip: "Apple silicon" };
const bodyOf = (url: string): string => new URL(url).searchParams.get("body")!;

describe("the new issue's address", () => {
  it("is the update feed's repository's issues/new, https on github.com, with only a body (the title left empty)", () => {
    expect(feedbackRepo).toEqual({ owner: UPDATE_GITHUB_FEED.owner, repo: UPDATE_GITHUB_FEED.repo });
    for (const kind of ["problem", "feedback"] as const) {
      const url = new URL(feedbackIssueUrl(kind, details, feedbackRepo));
      expect(`${url.origin}${url.pathname}`).toBe("https://github.com/adari-app/adari/issues/new");
      expect([...url.searchParams.keys()]).toEqual(["body"]);
      expect(url.hash).toBe("");
      expect(url.username + url.password + url.port).toBe("");
    }
  });

  it("names the repository nowhere but the update feed (no second copy)", () => {
    for (const file of ["src/shared/feedback.ts", "src/main/feedback.ts", "src/main/menu.ts", "src/renderer/settings/SettingsPage.tsx"]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/adari-app|github\.com\/adari/);
    }
  });

  it("Report a Problem: What happened, What you expected, Steps, then the details, exactly", () => {
    expect(bodyOf(feedbackIssueUrl("problem", details, feedbackRepo))).toBe(
      [
        "### What happened",
        "",
        "",
        "### What you expected",
        "",
        "",
        "### Steps",
        "",
        "",
        "### Details",
        "",
        "- Adari version: 0.1.1",
        "- Build: signed release",
        "- macOS: 15.1.0",
        "- Chip: Apple silicon",
        "",
      ].join("\n"),
    );
  });

  it("Send Feedback: Your idea or feedback, then the same details, exactly", () => {
    expect(bodyOf(feedbackIssueUrl("feedback", { ...details, signedRelease: false, chip: "Intel" }, feedbackRepo))).toBe(
      ["### Your idea or feedback", "", "", "### Details", "", "- Adari version: 0.1.1", "- Build: development build", "- macOS: 15.1.0", "- Chip: Intel", ""].join("\n"),
    );
  });

  it("the details block is four lines and nothing else", () => {
    for (const kind of ["problem", "feedback"] as const) {
      const body = bodyOf(feedbackIssueUrl(kind, details, feedbackRepo));
      const block = body.slice(body.indexOf("### Details\n\n") + "### Details\n\n".length).trimEnd().split("\n");
      expect(block).toEqual(feedbackDetailLines(details));
      expect(block.map((line) => line.slice(0, line.indexOf(":")))).toEqual(["- Adari version", "- Build", "- macOS", "- Chip"]);
    }
  });

  it("encodes odd characters in the version; a line break in it cannot add a line", () => {
    const odd = "0.1.1-beta+exp/5 &title=x#y?z%20 é😀";
    const url = feedbackIssueUrl("problem", { ...details, version: odd }, feedbackRepo);
    // Nothing raw in the body that a browser or GitHub would read as the end of it, or as another field.
    expect(url.slice(url.indexOf("?body=") + "?body=".length)).not.toMatch(/[ #&+?=\n]|%(?![0-9A-F]{2})/);
    const parsed = new URL(url);
    expect([...parsed.searchParams.keys()]).toEqual(["body"]);
    expect(parsed.hash).toBe("");
    expect(bodyOf(url)).toContain(`- Adari version: ${odd}\n`);
    expect(isFeedbackIssueUrl(url, feedbackRepo)).toBe(true);
    const split = bodyOf(feedbackIssueUrl("problem", { ...details, version: "0.1.1\n- Host: secret\r\n" }, feedbackRepo));
    expect(split).toContain("- Adari version: 0.1.1 - Host: secret\n");
    expect(split.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
  });

  it("stays under 2,000 characters, however long or odd the version and macOS values", () => {
    expect(maxFeedbackUrlLength).toBe(2_000);
    for (const value of ["9".repeat(5_000), "😀".repeat(3_000), "%&#\u0000 ".repeat(2_000)]) {
      for (const kind of ["problem", "feedback"] as const) {
        const url = feedbackIssueUrl(kind, { version: value, signedRelease: false, macOS: value, chip: value }, feedbackRepo);
        expect(url.length).toBeLessThan(2_000);
        expect(isFeedbackIssueUrl(url, feedbackRepo)).toBe(true);
        const body = bodyOf(url);
        expect(body).toContain("### Details");
        expect(body.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
      }
    }
    // An ordinary build's address is well under it, values in full.
    expect(feedbackIssueUrl("problem", details, feedbackRepo).length).toBeLessThan(600);
  });

  it("only a new issue of this one repository passes the check", () => {
    const good = feedbackIssueUrl("problem", details, feedbackRepo);
    expect(isFeedbackIssueUrl(good, feedbackRepo)).toBe(true);
    expect(isSafeExternalUrl(good)).toBe(true);
    const query = good.slice(good.indexOf("?"));
    for (const bad of [
      good.replace("https:", "http:"),
      `https://evil.example/adari-app/adari/issues/new${query}`,
      `https://github.com.evil.example/adari-app/adari/issues/new${query}`,
      `https://gist.github.com/adari-app/adari/issues/new${query}`,
      `https://user:pw@github.com/adari-app/adari/issues/new${query}`,
      `https://github.com:8443/adari-app/adari/issues/new${query}`,
      `https://github.com/someone/else/issues/new${query}`,
      `https://github.com/adari-app/adari/pulls${query}`,
      `https://github.com/adari-app/adari/issues/new/../../../evil${query}`,
      `https://github.com/adari-app/adari/issues/new${query}#x`,
      `${good}&assignees=me`,
      `${good}&body=again`,
      "https://github.com/adari-app/adari/issues/new",
      `${good}${"a".repeat(2_000)}`,
      "javascript:alert(1)",
      "",
    ]) {
      expect(isFeedbackIssueUrl(bad, feedbackRepo), bad.slice(0, 80)).toBe(false);
    }
  });
});

describe("the four details, read from this build and this Mac", () => {
  const facts = { version: "0.1.1", packaged: true, signed: true, platform: "darwin" as const, systemVersion: "15.1.0", arch: "arm64", translated: false };

  it("a signed release only when packaged and made to be signed; else a development build", () => {
    expect(feedbackDetails(facts)).toEqual({ version: "0.1.1", signedRelease: true, macOS: "15.1.0", chip: "Apple silicon" });
    expect(feedbackDetails({ ...facts, signed: false }).signedRelease).toBe(false);
    expect(feedbackDetails({ ...facts, packaged: false }).signedRelease).toBe(false);
  });

  it("the chip family: Apple silicon (also an Intel build under Rosetta), or Intel", () => {
    expect(chipFamily("arm64", false)).toBe("Apple silicon");
    expect(chipFamily("x64", true)).toBe("Apple silicon");
    expect(chipFamily("x64", false)).toBe("Intel");
    expect(feedbackDetails({ ...facts, arch: "x64" }).chip).toBe("Intel");
  });

  it("holds those four and nothing else", () => {
    expect(Object.keys(feedbackDetails(facts)).sort()).toEqual(["chip", "macOS", "signedRelease", "version"]);
  });
});

describe("main opens it through its link opener, and nothing else", () => {
  it("each kind: the opener called once with the checked address", () => {
    for (const kind of ["problem", "feedback"] as const) {
      const opened: string[] = [];
      expect(openFeedbackIssue(kind, details, (url) => opened.push(url))).toBe(true);
      expect(opened).toEqual([feedbackIssueUrl(kind, details, feedbackRepo)]);
      expect(isFeedbackIssueUrl(opened[0]!, feedbackRepo)).toBe(true);
    }
  });

  it("only the two kinds; the words people see", () => {
    expect(isFeedbackKind("problem")).toBe(true);
    expect(isFeedbackKind("feedback")).toBe(true);
    for (const other of ["https://evil.example/", "", null, undefined, 1, {}, ["problem"]]) expect(isFeedbackKind(other)).toBe(false);
    expect(feedbackMenuLabels).toEqual({ problem: "Report a Problem…", feedback: "Send Feedback…" });
    expect(feedbackFoot).toBe("Opens a new issue on GitHub in your browser. Adari sends nothing itself.");
  });

  it("the main side asks nothing of the network and keeps nothing", () => {
    for (const file of ["src/shared/feedback.ts", "src/main/feedback.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/\bfetch\(|net\.request|from\s+["'](node:)?(https?|net|tls|fs|child_process)["']|writeFile|localStorage/);
    }
  });
});
