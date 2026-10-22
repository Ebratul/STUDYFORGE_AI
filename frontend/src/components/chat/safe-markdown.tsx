"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * AI output and document text are untrusted. Defence in depth:
 *  1. react-markdown never renders raw HTML (it is ignored, not injected);
 *  2. rehype-sanitize strips anything outside an allow-list (no scripts, styles, iframes, forms, event handlers);
 *  3. only http(s)/mailto links, opened with rel=noopener noreferrer nofollow;
 *  4. images are never rendered: a remote image URL is a classic data-exfiltration channel for prompt injection.
 */
export const markdownSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img"),
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"] },
};

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: React.ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textOf(children).replace(/\n$/, "");
  return (
    <div className="group relative my-3">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground opacity-0 transition focus:opacity-100 group-hover:opacity-100"
        aria-label="Copy code"
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />} {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto rounded-xl border bg-muted p-3 text-[13px] leading-relaxed"><code>{children}</code></pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">{children}</a>
  ),
  img: () => null,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className?.includes("language-") && "bg-transparent p-0")}>{children}</code>,
  table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border bg-muted px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
};

export function SafeMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-chat break-words text-[15px] leading-7 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, markdownSchema]]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
