import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { InviteCreatedPanel } from "@/components/groups/invite-created-panel";
import { RoleBadge, StatusChip } from "@/components/groups/badges";
import { DistributionChart } from "@/components/leaderboard/distribution-chart";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { LeaderboardView } from "@/components/leaderboard/leaderboard-view";
import { readDistribution, readEntry } from "@/lib/leaderboard";
import type { CreatedInvite } from "@/lib/groups";

const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));
const entry = (o: Record<string, unknown>) => readEntry({ maxCenti: 1000, status: "SUBMITTED", entryId: String(Math.random()), displayName: "Someone", ...o });

describe("leaderboard table", () => {
  const items = [
    entry({ entryId: "1", rank: 1, displayName: "Rina", scoreCenti: 1000, percentBp: 10000, band: "EXCELLENT", submittedAt: "2026-01-01T10:00:00Z" }),
    entry({ entryId: "2", rank: 2, displayName: "Anonymous participant", scoreCenti: 800, percentBp: 8000 }),
    entry({ entryId: "3", rank: 2, displayName: "Sam", isSelf: true, scoreCenti: 800, percentBp: 8000 }),
    entry({ entryId: "4", rank: 4, displayName: "Zero Hero", scoreCenti: 0, percentBp: 0, status: "TIMED_OUT" }),
    entry({ entryId: "5", rank: null, displayName: "Running", status: "IN_PROGRESS", scoreCenti: null, percentBp: null }),
    entry({ entryId: "6", rank: null, displayName: "Absent", status: "NOT_STARTED", scoreCenti: null, percentBp: null }),
  ];
  const out = html(createElement(LeaderboardTable, { items }));
  it("shows ranks exactly as received (1, 2, 2, 4) and dashes for unranked rows", () => {
    expect([...out.matchAll(/data-rank="([^"]*)"/g)].map((m) => m[1])).toEqual(["1", "2", "2", "4", "", ""]);
    expect(out).toContain("Rank 4");
    expect(out).toContain("Not ranked");
  });
  it("labels medals with text, highlights the caller and keeps the anonymous name", () => {
    expect(out).toContain("1st place");
    expect(out).toContain("2nd place");
    expect(out).not.toContain("4th place");
    expect(out).toMatch(/data-self="true"/);
    expect(out).toContain(">You<");
    expect(out).toContain("Anonymous participant");
  });
  it("distinguishes a zero score from not started and in progress", () => {
    expect(out).toContain("Zero score");
    expect((out.match(/Zero score/g) ?? []).length).toBe(1);
    expect(out).toContain("Timed out");
    expect(out).toContain("In progress");
    expect(out).toContain("Not started");
    expect(out).toContain("0.00%");
  });
  it("exposes no identifiers", () => {
    expect(out).not.toMatch(/@/);
  });
});

describe("distribution chart", () => {
  it("lists all five bands with counts as text and a text alternative", () => {
    const out = html(createElement(DistributionChart, { distribution: readDistribution([{ band: "BELOW_60", count: 2 }, { band: "90_100", count: 1 }]) }));
    for (const label of ["Below 60%", "60% – below 70%", "70% – below 80%", "80% – below 90%", "90% – 100%"]) expect(out).toContain(label);
    expect(out).toContain("Score distribution of 3 ranked participants");
    expect(out).toContain('aria-hidden="true"'); // the SVG is a visual duplicate of the list
  });
  it("says so when there is nothing to chart", () => {
    expect(html(createElement(DistributionChart, { distribution: readDistribution([]) }))).toContain("nothing to chart");
  });
});

describe("leaderboard view", () => {
  const base = { examId: "e1", title: "Midterm", group: { id: "g1", title: "Biology club" } };
  it("not released: shows when results unlock and participation counts, no scores", () => {
    const out = html(createElement(LeaderboardView, { ...base, initial: { released: false, releasesAt: "2030-01-01T10:00:00Z", participants: { total: 5, submitted: 2, timedOut: 1, inProgress: 1, notStarted: 1 } } }));
    expect(out).toContain("Results aren&#x27;t released yet");
    expect(out).toContain("participation-counts");
    expect(out).not.toContain("leaderboard-table");
    expect(out).toContain("Biology club");
  });
  it("released: stat tiles, chart and the table", () => {
    const out = html(createElement(LeaderboardView, {
      ...base,
      initial: {
        released: true, policy: "COMPETITION_1224_BEST_ATTEMPT", total: 1, page: 1, pageSize: 25,
        items: [{ entryId: "x", rank: 1, displayName: "Rina", status: "SUBMITTED", scoreCenti: 900, maxCenti: 1000, percentBp: 9000, band: "EXCELLENT", submittedAt: "2026-01-01T10:00:00Z" }],
        stats: { participants: 4, ranked: 1, average: 9000, highest: 9000, lowest: 9000 }, distribution: [{ band: "90_100", count: 1 }],
      },
    }));
    expect(out).toContain("Group average");
    expect(out).toContain("90.00%");
    expect(out).toContain("leaderboard-table");
    expect(out).toContain("data-testid=\"distribution\"");
  });
});

describe("badges and the one-time invite panel", () => {
  it("spells the role out", () => {
    expect(html(createElement(RoleBadge, { role: "ADMIN" }))).toContain("Admin");
    expect(html(createElement(StatusChip, { status: "MISSED" }))).toContain("Missed");
  });
  const created: CreatedInvite = { code: "ABCDEFGHJKLMNPQRSTUVWXYZ23", link: "https://app.example/join/ABCDEFGHJKLMNPQRSTUVWXYZ23", invite: { id: "i", status: "ACTIVE", expiresAt: "2030-01-01T00:00:00Z", maxUses: 5, useCount: 0, codeHint: "Z23", forEmail: false, createdAt: null } };
  it("tells the owner this is the only time the code is visible and offers copy for code and link", () => {
    const out = html(createElement(InviteCreatedPanel, { created, onDismiss: () => {} }));
    expect(out).toContain("only time you&#x27;ll see this code");
    expect(out).toContain("ABCD EFGH JKLM NPQR STUV WXYZ 23");
    expect(out).toContain("Copy code");
    expect(out).toContain("Copy link");
    expect(out).toContain("0 of 5 uses");
  });
});
