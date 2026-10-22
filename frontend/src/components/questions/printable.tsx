"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { optionLabel, partLabel, LEVEL_LABEL, isInsufficient, type QuestionContent } from "@/lib/questions";

/**
 * Print support. The printable layout lives in a portal directly under <body>; `@media print` rules in globals.css hide everything else
 * while <html> carries `sf-printing`. On screen the portal is always hidden, so no other page is affected.
 */
export function usePrint() {
  const [answers, setAnswers] = useState(false);
  const print = useCallback((withAnswers: boolean) => {
    setAnswers(withAnswers);
    const root = document.documentElement;
    const done = () => root.classList.remove("sf-printing");
    window.addEventListener("afterprint", done, { once: true });
    requestAnimationFrame(() => {
      root.classList.add("sf-printing");
      window.print();
    });
  }, []);
  return { answers, print };
}

const subscribeNothing = () => () => {};

export function PrintableQuestions({ items, title, answers }: { items: QuestionContent[]; title: string; answers: boolean }) {
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (!mounted) return null;
  const mcqs = items.filter((q) => q.kind === "MCQ");
  return createPortal(
    <div className="sf-print-portal" data-testid="print-area">
      <header className="sf-print-head">
        <h1>{title || "Question set"}</h1>
        <p>{items.length} {items.length === 1 ? "question" : "questions"} · {new Date().toLocaleDateString([], { dateStyle: "long" })}</p>
        <p className="sf-print-note">Questions written with AI assistance. Check answer keys before use.</p>
      </header>
      <ol className="sf-print-list">
        {items.map((q, n) => (
          <li key={n} className="sf-q" lang={q.language}>
            {q.stimulus && <blockquote>{q.stimulus}</blockquote>}
            <p className="sf-q-stem"><strong>{n + 1}.</strong> {q.stem} <span className="sf-q-marks">[{q.marks}]</span></p>
            {q.kind === "MCQ" ? (
              <ol className="sf-options">
                {q.options.map((o, i) => <li key={o.id}><strong>{optionLabel(i, q.language)}.</strong> {o.text}</li>)}
              </ol>
            ) : (
              <ol className="sf-options">
                {q.parts.map((p, i) => (
                  <li key={p.id}>
                    <strong>{p.label ?? partLabel(i, q.language)}.</strong> {p.prompt} <span className="sf-q-marks">[{p.marks}]{p.level ? ` · ${LEVEL_LABEL[q.language][p.level]}` : ""}</span>
                    {answers && p.answer && <p className="sf-answer"><em>Model answer:</em> {isInsufficient(p.answer) ? "Insufficient evidence in the sources." : p.answer.text}</p>}
                  </li>
                ))}
                {answers && q.parts.length === 0 && q.answer && <li className="sf-answer"><em>Model answer:</em> {isInsufficient(q.answer) ? "Insufficient evidence in the sources." : q.answer.text}</li>}
              </ol>
            )}
          </li>
        ))}
      </ol>
      {answers && mcqs.length > 0 && (
        <section className="sf-key">
          <h2>Answer key</h2>
          <ol>
            {items.map((q, n) => {
              if (q.kind !== "MCQ") return null;
              const i = q.options.findIndex((o) => o.id === q.correctOptionId);
              return (
                <li key={n} value={n + 1} lang={q.language}>
                  <strong>{i >= 0 ? optionLabel(i, q.language) : "—"}</strong>{i >= 0 ? ` — ${q.options[i]?.text ?? ""}` : ""}
                  {q.explanation && <span className="sf-answer"> {q.explanation}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>,
    document.body,
  );
}
