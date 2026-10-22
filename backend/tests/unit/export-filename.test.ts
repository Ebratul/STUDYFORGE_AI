import { describe, expect, it } from "vitest";
import { contentDisposition, exportFilename } from "../../src/modules/questions/export/index.js";

const NOW = new Date("2026-10-22T10:00:00Z");

describe("exportFilename", () => {
  it("slugs the title and appends the date and extension", () => {
    expect(exportFilename("Biology — Chapter 3 Quiz!", "pdf", NOW)).toBe("biology-chapter-3-quiz-20261022.pdf");
  });
  it("falls back to 'questions' for empty or non-ASCII titles", () => {
    expect(exportFilename(undefined, "json", NOW)).toBe("questions-20261022.json");
    expect(exportFilename("   ", "txt", NOW)).toBe("questions-20261022.txt");
    expect(exportFilename("জীববিজ্ঞান প্রশ্ন", "pdf", NOW)).toBe("questions-20261022.pdf");
    expect(exportFilename("জীববিজ্ঞান Quiz", "pdf", NOW)).toBe("quiz-20261022.pdf");
  });
  it("neutralises path traversal, separators, quotes, control characters and extension tricks", () => {
    for (const title of ["../../etc/passwd", "..\\..\\windows\\system32", 'a"b;c\r\nSet-Cookie: x=1', "/abs/path", "%2e%2e%2f", "x\u0000y"]) {
      const name = exportFilename(title, "pdf", NOW);
      expect(name).toMatch(/^[a-z0-9-]+-20261022\.pdf$/);
      expect(name).not.toContain("..");
    }
    expect(exportFilename("../../etc/passwd", "pdf", NOW)).toBe("etc-passwd-20261022.pdf");
    expect(exportFilename("t", "../pdf", NOW)).toBe("t-20261022.pdf");
    expect(exportFilename("t", "", NOW)).toBe("t-20261022.bin");
  });
  it("is at most 80 characters", () => {
    expect(exportFilename("a".repeat(500), "json", NOW).length).toBeLessThanOrEqual(80);
    expect(exportFilename("a b ".repeat(100), "json", NOW).length).toBeLessThanOrEqual(80);
  });
});

describe("contentDisposition", () => {
  it("is an attachment with a safe name", () => {
    expect(contentDisposition("quiz-20261022.pdf")).toBe(`attachment; filename="quiz-20261022.pdf"; filename*=UTF-8''quiz-20261022.pdf`);
    expect(contentDisposition('a"b\r\n.pdf')).not.toMatch(/[\r\n]/);
  });
});
