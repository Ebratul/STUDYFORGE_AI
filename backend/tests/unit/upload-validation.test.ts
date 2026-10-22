import { describe, expect, it } from "vitest";
import { sanitizeFilename, validateUpload } from "../../src/modules/documents/validation.js";
import { AppError } from "../../src/lib/errors.js";

const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml....")]);
const text = Buffer.from("Photosynthesis converts light energy into chemical energy.\nসালোকসংশ্লেষণ।");

function fails(fn: () => unknown, code: string, re?: RegExp) {
  try {
    fn();
    expect.unreachable("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    if (re) expect((e as AppError).message).toMatch(re);
  }
}

describe("upload validation", () => {
  it("accepts valid PDF, DOCX, TXT and Markdown", () => {
    expect(validateUpload("a.pdf", "application/pdf", pdf).ext).toBe("pdf");
    expect(validateUpload("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx).ext).toBe("docx");
    expect(validateUpload("a.txt", "text/plain", text).ext).toBe("txt");
    expect(validateUpload("a.md", "text/markdown", text).ext).toBe("md");
    expect(validateUpload("a.markdown", "", text).ext).toBe("md");
    expect(validateUpload("a.txt", "application/octet-stream", text).ext).toBe("txt"); // neutral MIME is fine, content is checked
  });

  it("rejects an executable renamed to .pdf (signature check, not extension)", () => {
    fails(() => validateUpload("evil.pdf", "application/pdf", Buffer.from("MZ\x90\x00\x03\x00\x00\x00")), "UNSUPPORTED_MEDIA", /valid PDF/);
  });

  it("rejects a plain zip renamed to .docx and a PDF renamed to .docx", () => {
    fails(() => validateUpload("a.docx", "", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("other.txt")])), "UNSUPPORTED_MEDIA");
    fails(() => validateUpload("a.docx", "", pdf), "UNSUPPORTED_MEDIA");
  });

  it("rejects binary data posing as text", () => {
    fails(() => validateUpload("a.txt", "text/plain", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a])), "UNSUPPORTED_MEDIA", /plain text/);
    fails(() => validateUpload("a.md", "", Buffer.from([0x61, 0xc3, 0x28, 0x62])), "UNSUPPORTED_MEDIA");
  });

  it("rejects a declared MIME that contradicts the extension", () => {
    fails(() => validateUpload("a.pdf", "image/png", pdf), "UNSUPPORTED_MEDIA", /doesn't match/);
    fails(() => validateUpload("a.txt", "application/pdf", text), "UNSUPPORTED_MEDIA");
  });

  it("rejects unknown extensions, double extensions and no extension", () => {
    for (const name of ["a.exe", "a.pdf.exe", "a.html", "a.svg", "noext", "a.js"]) fails(() => validateUpload(name, "", text), "UNSUPPORTED_MEDIA");
  });

  it("rejects video with an explicit explanation", () => {
    fails(() => validateUpload("lecture.mp4", "video/mp4", Buffer.alloc(100)), "UNSUPPORTED_MEDIA", /transcription/);
    fails(() => validateUpload("x.bin", "video/webm", Buffer.alloc(100)), "UNSUPPORTED_MEDIA", /transcription/);
  });

  it("rejects empty and oversized files", () => {
    fails(() => validateUpload("a.txt", "text/plain", Buffer.alloc(0)), "VALIDATION", /empty/);
    const max = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
    fails(() => validateUpload("a.txt", "text/plain", Buffer.alloc(max + 1, 97)), "VALIDATION", /too large/);
  });

  it("sanitises file names (path traversal, control and bidi characters, length)", () => {
    expect(sanitizeFilename("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFilename("C:\\Users\\me\\notes.pdf")).toBe("notes.pdf");
    expect(sanitizeFilename("a\u0000b\u202e.pdf")).toBe("ab.pdf");
    expect(sanitizeFilename("   ")).toBe("document");
    expect(sanitizeFilename(`${"x".repeat(400)}.pdf`).length).toBeLessThanOrEqual(200);
  });
});
