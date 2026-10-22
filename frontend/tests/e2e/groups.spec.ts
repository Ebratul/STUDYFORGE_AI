import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, PASSWORD, signOut, sql, test } from "./fixtures";
import { addMember, api, createGroup, createInvite, insertUser, joinViaApi, newUser, seedGroupExam, seedInProgress, seedResult } from "./group-helpers";

async function a11y(page: Page, label: string) {
  await page.waitForLoadState("load");
  // Let dialog/tab transitions finish: axe would otherwise sample colours mid-fade.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
}
const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
const NOT_FOUND = /couldn.t find what you were looking for|not found/i;

test.describe("creating and managing a group", () => {
  test("create a group from the dialog; the form validates and the server confirms", async ({ browser }) => {
    const a = await newUser(browser);
    await a.page.goto("/groups");
    await expect(a.page.getByText("You're not in any group yet")).toBeVisible();
    await a.page.getByRole("button", { name: "New group" }).click();
    await a.page.getByRole("button", { name: "Create group" }).click();
    await expect(a.page.getByText("Give the group a name.")).toBeVisible();
    await a.page.getByLabel("Group name").fill("Physics circle");
    await a.page.getByLabel("Member capacity").fill("1");
    await a.page.getByRole("button", { name: "Create group" }).click();
    await expect(a.page.getByText(/Choose a whole number from 2 to/)).toBeVisible();
    await a.page.getByLabel("Member capacity").fill("501");
    await a.page.getByRole("button", { name: "Create group" }).click();
    await expect(a.page.getByText(/Choose a whole number from 2 to/)).toBeVisible();
    await a.page.getByLabel("Member capacity").fill("12");
    await a.page.getByLabel("Description (optional)").fill("Mechanics every Thursday");
    await a.page.getByRole("button", { name: "Create group" }).click();
    await expect(a.page).toHaveURL(/\/groups\/[^/]+$/);
    await expect(a.page.getByTestId("group-title")).toHaveText("Physics circle");
    await expect(a.page.getByText("1 of 12 members").first()).toBeVisible();
    await expect(a.page.getByText("Mechanics every Thursday")).toBeVisible();
    // The owner sees every tab, and cannot "leave" the group they own.
    for (const name of ["Overview", "Members", "Invitations", "Exams", "Settings"]) await expect(tab(a.page, name)).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Leave group" })).toHaveCount(0);
    await a.page.goto("/groups");
    await expect(a.page.getByTestId("group-card")).toContainText("Physics circle");
    await a.ctx.close();
  });

  test("settings: capacity can't go below the member count; deleting needs the typed name", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser, "Member Bee");
    const gid = await createGroup(a.page, { title: "Chem lab", capacity: 5 });
    await joinViaApi(b.page, (await createInvite(a.page, gid)).code);
    await a.page.goto(`/groups/${gid}?tab=settings`);
    await a.page.getByLabel("Member capacity").fill("1");
    await a.page.getByRole("button", { name: "Save changes" }).click();
    await expect(a.page.getByText(/Choose a whole number from 2/)).toBeVisible();
    await a.page.getByLabel("Member capacity").fill("8");
    await a.page.getByRole("button", { name: "Save changes" }).click();
    await expect(a.page.getByText("Group updated")).toBeVisible();
    await a.page.reload();
    await expect(a.page.getByText("2 of 8 members").first()).toBeVisible();

    await a.page.getByRole("button", { name: "Delete group…" }).click();
    const del = a.page.getByRole("dialog").getByRole("button", { name: "Delete group" });
    await expect(del).toBeDisabled();
    await a.page.getByRole("dialog").getByLabel("Group name").fill("Chem lab");
    await expect(del).toBeEnabled();
    await del.click();
    await expect(a.page).toHaveURL(/\/groups$/);
    expect((await api(b.page, "GET", `/api/groups/${gid}`)).status()).toBe(404);
    await a.ctx.close();
    await b.ctx.close();
  });
});

test.describe("invitations", () => {
  test("the code is shown once, a second user joins with the link, and the list never shows the code again", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser, "Bee Joiner");
    const gid = await createGroup(a.page, { title: "History club" });

    await a.page.goto(`/groups/${gid}?tab=invites`);
    await a.page.getByRole("button", { name: "New invitation" }).click();
    await a.page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    const panel = a.page.getByTestId("invite-created");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("only time you'll see this code");
    const code = ((await a.page.getByTestId("invite-code").innerText()) as string).replace(/\s+/g, ""); // as issued: grouped with dashes
    const plain = code.replace(/-/g, "");
    expect(plain.length).toBeGreaterThanOrEqual(20);
    const link = await a.page.getByTestId("invite-link").innerText();
    expect(link).toContain(`/join/${code}`);
    await expect(panel.getByRole("button", { name: "Copy code" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Copy link" })).toBeVisible();
    // Switching tabs doesn't lose the panel; dismissing removes it for good.
    await tab(a.page, "Members").click();
    await tab(a.page, "Invitations").click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "I've saved it" }).click();
    await expect(a.page.getByTestId("invite-created")).toHaveCount(0);
    await a.page.reload();
    await expect(a.page.getByTestId("invite-row")).toHaveCount(1);
    await expect(a.page.getByTestId("invite-row")).toContainText(plain.slice(-4));
    const html = await a.page.content();
    expect(html).not.toContain(code); // the full code is nowhere on the page any more
    expect(html).not.toContain(plain);

    // Joining through the link
    await b.page.goto(`/join/${code}`);
    await expect(b.page.getByTestId("join-group-title")).toHaveText("History club");
    await b.page.getByRole("button", { name: "Join group" }).click();
    await expect(b.page).toHaveURL(new RegExp(`/groups/${gid}$`));
    await expect(b.page.getByTestId("group-title")).toHaveText("History club");
    await tab(b.page, "Members").click();
    await expect(b.page.getByTestId("member-row")).toHaveCount(2);
    await a.page.goto(`/groups/${gid}?tab=invites`);
    await expect(a.page.getByTestId("invite-row")).toContainText("1 of 10 uses");
    await a.ctx.close();
    await b.ctx.close();
  });

  test("the paste-a-code form accepts a code, a spaced code or a whole link", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Paste club" });
    const { code, link } = await createInvite(a.page, gid);
    for (const text of [code, `${code.slice(0, 4)} ${code.slice(4, 8)}-${code.slice(8)}`, link]) {
      await b.page.goto("/join");
      await b.page.getByLabel("Invitation code").fill(text);
      await b.page.getByRole("button", { name: "Continue" }).click();
      await expect(b.page).toHaveURL(new RegExp(`/join/${code.replace(/-/g, "")}$`)); // separators are stripped
      await expect(b.page.getByTestId("join-group-title")).toHaveText("Paste club");
    }
    await b.page.goto("/join");
    await b.page.getByLabel("Invitation code").fill("abc");
    await b.page.getByRole("button", { name: "Continue" }).click();
    await expect(b.page.getByText(/doesn.t look like a full invitation code/)).toBeVisible();
    await a.ctx.close();
    await b.ctx.close();
  });

  test("signed-out visitors sign in and come back to the invitation", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser, "Returning Rita");
    const gid = await createGroup(a.page, { title: "Redirect club" });
    const { code } = await createInvite(a.page, gid);
    await signOut(b.page);
    await b.page.goto(`/join/${code}`);
    await expect(b.page).toHaveURL(/\/login\?next=/);
    await b.page.getByLabel("Email").fill(b.email);
    await b.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await b.page.getByRole("button", { name: "Sign in" }).click();
    await expect(b.page).toHaveURL(new RegExp(`/join/${code}$`)); // back on the exact link that was followed
    await expect(b.page.getByTestId("join-group-title")).toHaveText("Redirect club");
    await a.ctx.close();
    await b.ctx.close();
  });

  test("unknown, expired and revoked codes all get the same generic message", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Generic club" });
    const expired = await createInvite(a.page, gid);
    const revoked = await createInvite(a.page, gid);
    await sql(`UPDATE "GroupInvite" SET "expiresAt" = now() - interval '1 hour' WHERE id = $1`, [expired.invite.id]);
    expect((await api(a.page, "DELETE", `/api/groups/${gid}/invites/${revoked.invite.id}`)).status()).toBe(200);
    const messages: string[] = [];
    for (const code of ["ZZZZZZZZZZZZZZZZZZZZZZZZZZ", expired.code.replace(/-/g, ""), revoked.code.replace(/-/g, "")]) {
      await b.page.goto(`/join/${code}`);
      const alert = b.page.getByTestId("join-error");
      await expect(alert).toContainText("isn't valid");
      messages.push(await alert.innerText());
      await expect(b.page.getByRole("button", { name: "Join group" })).toHaveCount(0);
    }
    expect(new Set(messages).size).toBe(1);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("revoking from the list makes the code unusable", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Revoke club" });
    const { code } = await createInvite(a.page, gid);
    await a.page.goto(`/groups/${gid}?tab=invites`);
    await a.page.getByRole("button", { name: /^Revoke invitation ending/ }).click();
    await a.page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
    await expect(a.page.getByTestId("invite-row")).toContainText("Revoked");
    await b.page.goto(`/join/${code.replace(/-/g, "")}`);
    await expect(b.page.getByTestId("join-error")).toContainText("isn't valid");
    await a.ctx.close();
    await b.ctx.close();
  });

  test("a full group says so and refuses the join", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const c = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Tiny club", capacity: 2 });
    const { code } = await createInvite(a.page, gid);
    await joinViaApi(b.page, code);
    await c.page.goto(`/join/${code}`);
    await expect(c.page.getByText(/this group is full/)).toBeVisible();
    await expect(c.page.getByRole("button", { name: "Join group" })).toBeDisabled();
    const res = await api(c.page, "POST", "/api/groups/join", { code });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("GROUP_FULL");
    await a.ctx.close();
    await b.ctx.close();
    await c.ctx.close();
  });
});

test.describe("members, roles and permissions", () => {
  test("owner promotes and removes; plain members get no management UI and the API refuses them anyway", async ({ browser }) => {
    const a = await newUser(browser, "Olivia Owner");
    const b = await newUser(browser, "Bela Member");
    const c = await newUser(browser, "Chris Member");
    const gid = await createGroup(a.page, { title: "Roles club" });
    const { code } = await createInvite(a.page, gid);
    await joinViaApi(b.page, code);
    await joinViaApi(c.page, code);

    // A plain member: no Invitations / Settings tabs, no member actions, and the API refuses direct calls.
    await c.page.goto(`/groups/${gid}`);
    await expect(tab(c.page, "Invitations")).toHaveCount(0);
    await expect(tab(c.page, "Settings")).toHaveCount(0);
    await c.page.goto(`/groups/${gid}?tab=members`);
    await expect(c.page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
    expect([403, 404]).toContain((await api(c.page, "POST", `/api/groups/${gid}/invites`, { expiresInHours: 1, maxUses: 1 })).status());
    expect([403, 404]).toContain((await api(c.page, "PATCH", `/api/groups/${gid}`, { title: "Hijacked" })).status());
    expect([403, 404]).toContain((await api(c.page, "DELETE", `/api/groups/${gid}/members/${b.id}`)).status());

    // Owner makes Bela an admin.
    await a.page.goto(`/groups/${gid}?tab=members`);
    const bRow = a.page.getByTestId("member-row").filter({ hasText: "Bela Member" });
    await bRow.getByRole("button", { name: "Actions for Bela Member" }).click();
    await a.page.getByRole("menuitem", { name: "Make admin" }).click();
    await expect(bRow).toContainText("Admin");
    await b.page.goto(`/groups/${gid}`);
    await expect(tab(b.page, "Invitations")).toBeVisible();
    await expect(tab(b.page, "Settings")).toHaveCount(0);
    // An admin may remove a member but not the owner or another admin.
    await b.page.goto(`/groups/${gid}?tab=members`);
    await expect(b.page.getByTestId("member-row").filter({ hasText: "Olivia Owner" }).getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
    expect([403, 404]).toContain((await api(b.page, "DELETE", `/api/groups/${gid}/members/${a.id}`)).status());

    // Owner removes Chris with a confirmation; Chris loses access.
    const cRow = a.page.getByTestId("member-row").filter({ hasText: "Chris Member" });
    await cRow.getByRole("button", { name: "Actions for Chris Member" }).click();
    await a.page.getByRole("menuitem", { name: "Remove from group" }).click();
    await a.page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
    await expect(a.page.getByTestId("member-row")).toHaveCount(2);
    await c.page.goto(`/groups/${gid}`);
    await expect(c.page.getByText(NOT_FOUND).first()).toBeVisible();
    for (const u of [a, b, c]) await u.ctx.close();
  });

  test("a member can leave after confirming, and the privacy toggle is saved by the server", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser, "Leaving Lee");
    const gid = await createGroup(a.page, { title: "Leave club" });
    await joinViaApi(b.page, (await createInvite(a.page, gid)).code);
    await b.page.goto(`/groups/${gid}`);
    const sw = b.page.getByRole("switch", { name: "Show my name on leaderboards" });
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(b.page.getByText(/Anonymous participant/).first()).toBeVisible();
    await b.page.reload();
    await expect(b.page.getByRole("switch", { name: "Show my name on leaderboards" })).not.toBeChecked();
    await b.page.getByRole("button", { name: "Leave group" }).click();
    await b.page.getByRole("dialog").getByRole("button", { name: "Leave group" }).click();
    await expect(b.page).toHaveURL(/\/groups$/);
    await expect(b.page.getByTestId("group-card")).toHaveCount(0);
    expect((await api(b.page, "GET", `/api/groups/${gid}`)).status()).toBe(404);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("a stranger can't open a group", async ({ browser }) => {
    const a = await newUser(browser);
    const d = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Private club" });
    await d.page.goto(`/groups/${gid}`);
    await expect(d.page.getByText(NOT_FOUND).first()).toBeVisible();
    expect((await api(d.page, "GET", `/api/groups/${gid}/members`)).status()).toBe(404);
    await a.ctx.close();
    await d.ctx.close();
  });
});

async function seedClass(browser: import("@playwright/test").Browser) {
  const a = await newUser(browser, "Olivia Owner"); // staff: author of the exam, not a participant
  const b = await newUser(browser, "Bela Member"); // 85 %
  const gid = await createGroup(a.page, { title: "Leaderboard class", capacity: 40 });
  await joinViaApi(b.page, (await createInvite(a.page, gid)).code);
  const exam = await seedGroupExam({ groupId: gid, ownerId: a.id, title: "Midterm", questionCount: 10 });
  const mk = async (name: string, score: number | "progress" | "none", opts: { showName?: boolean; status?: "SUBMITTED" | "TIMED_OUT" } = {}) => {
    const id = await insertUser(name);
    await addMember(gid, id, { showName: opts.showName ?? true });
    if (score === "progress") await seedInProgress(exam, id);
    else if (score !== "none") await seedResult(exam, id, score, opts.status);
    return id;
  };
  await seedResult(exam, b.id, 850);
  await mk("Priya Top", 1000);
  await mk("Quinn Tied", 850);
  await mk("Sam Mid", 600);
  await mk("Tara Late", 300, { status: "TIMED_OUT" });
  await mk("Zed Zero", 0);
  await mk("Ian Running", "progress");
  await mk("Nila Absent", "none");
  return { a, b, gid, exam };
}

test.describe("leaderboard", () => {
  test("released results: server ranks (1, 2, 2, 4…), statuses, zero score, stats and the distribution chart", async ({ browser }) => {
    const { a, b, exam } = await seedClass(browser);
    await b.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(b.page.getByTestId("leaderboard-title")).toHaveText("Midterm");
    const rows = b.page.getByTestId("leaderboard-row");
    await expect(rows).toHaveCount(8);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-rank")))).toEqual(["1", "2", "2", "4", "5", "6", "", ""]);
    await expect(rows.nth(0)).toContainText("Priya Top");
    await expect(rows.nth(0)).toContainText("100.00%");
    await expect(b.page.locator('[data-self="true"]')).toContainText("Bela Member");
    await expect(b.page.locator('[data-self="true"]')).toContainText("You");
    // zero score vs timed out vs in progress vs not started
    await expect(rows.nth(5)).toContainText("Zero score");
    await expect(b.page.getByText("Zero score")).toHaveCount(1);
    await expect(rows.nth(4)).toContainText("Timed out");
    await expect(rows.nth(6)).toContainText("In progress");
    await expect(rows.nth(7)).toContainText("Not started");
    await expect(rows.nth(6)).not.toContainText("%");
    // stats + chart
    const stats = b.page.getByTestId("leaderboard-stats");
    await expect(stats).toContainText("Participants");
    await expect(stats).toContainText("Highest");
    await expect(stats).toContainText("100.00%");
    await expect(stats).toContainText("0.00%");
    await expect(b.page.getByTestId("distribution-chart").locator("svg")).toBeVisible();
    const list = b.page.getByTestId("distribution-list").locator("li");
    await expect(list).toHaveCount(5);
    const counts = (await list.allInnerTexts()).map((t) => Number(/(\d+)\s*(?:\(|$)/.exec(t.replace(/\n/g, " "))?.[1]));
    expect(counts).toEqual([2, 1, 0, 2, 1]);
    expect(await b.page.getByRole("main").innerHTML()).not.toMatch(/@example\.test/); // no e-mail addresses on the leaderboard (the sidebar shows only my own)
    // Staff (the author) sees the same ranking plus the participation list.
    await a.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(a.page.getByTestId("leaderboard-row")).toHaveCount(8);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("members who hide their name appear as 'Anonymous participant' to others but not to themselves", async ({ browser }) => {
    const a = await newUser(browser, "Olivia Owner");
    const b = await newUser(browser, "Hidden Hana");
    const c = await newUser(browser, "Viewer Vic");
    const gid = await createGroup(a.page, { title: "Privacy class" });
    const { code } = await createInvite(a.page, gid);
    await joinViaApi(b.page, code);
    await joinViaApi(c.page, code);
    const exam = await seedGroupExam({ groupId: gid, ownerId: a.id });
    await seedResult(exam, b.id, 900);
    await seedResult(exam, c.id, 500);
    expect((await api(b.page, "PATCH", `/api/groups/${gid}/me`, { showNameOnLeaderboard: false })).status()).toBe(200);
    await c.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(c.page.getByTestId("leaderboard-table")).toContainText("Anonymous participant");
    await expect(c.page.getByTestId("leaderboard-table")).not.toContainText("Hidden Hana");
    await b.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(b.page.locator('[data-self="true"]')).toContainText("Hidden Hana");
    for (const u of [a, b, c]) await u.ctx.close();
  });

  test("before release there are no scores in the page or in the API response", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Locked class" });
    await joinViaApi(b.page, (await createInvite(a.page, gid)).code);
    const exam = await seedGroupExam({ groupId: gid, ownerId: a.id, releaseMode: "AT_TIME", releaseAt: new Date(Date.now() + 86_400_000) });
    await seedResult(exam, b.id, 777);
    await b.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(b.page.getByTestId("leaderboard-locked")).toContainText("Results aren't released yet");
    await expect(b.page.getByTestId("participation-counts")).toContainText("Submitted");
    await expect(b.page.getByTestId("leaderboard-table")).toHaveCount(0);
    const res = await api(b.page, "GET", `/api/exams/${exam.examId}/leaderboard`);
    const body = await res.json();
    expect(body.released).toBe(false);
    expect(body.items).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/777|scoreCenti|percentBp/);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("paginates large groups and keeps server ranks across pages", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Big class", capacity: 100 });
    await joinViaApi(b.page, (await createInvite(a.page, gid)).code);
    const exam = await seedGroupExam({ groupId: gid, ownerId: a.id, questionCount: 100 });
    await seedResult(exam, b.id, 10_000); // 100 %
    for (let i = 0; i < 26; i++) {
      const id = await insertUser(`Student ${i + 1}`);
      await addMember(gid, id);
      await seedResult(exam, id, 9_900 - i * 100);
    }
    await b.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(b.page.getByTestId("leaderboard-row")).toHaveCount(25);
    await expect(b.page.getByText("Showing 1–25 of 27")).toBeVisible();
    await b.page.getByRole("button", { name: "Next" }).click();
    await expect(b.page.getByTestId("leaderboard-row")).toHaveCount(2);
    expect(await b.page.getByTestId("leaderboard-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-rank")))).toEqual(["26", "27"]);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("non-members can't see a group exam's leaderboard", async ({ browser }) => {
    const a = await newUser(browser);
    const d = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Closed class" });
    const exam = await seedGroupExam({ groupId: gid, ownerId: a.id });
    await d.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(d.page.getByText(NOT_FOUND).first()).toBeVisible();
    expect((await api(d.page, "GET", `/api/exams/${exam.examId}/leaderboard`)).status()).toBe(404);
    await a.ctx.close();
    await d.ctx.close();
  });

  test("the group's exam list shows my participation status and links to the leaderboard", async ({ browser }) => {
    const { a, b, gid, exam } = await seedClass(browser);
    await b.page.goto(`/groups/${gid}?tab=exams`);
    const row = b.page.getByTestId("group-exam-row").filter({ hasText: "Midterm" });
    await expect(row).toContainText("Submitted");
    await row.getByRole("link", { name: "Leaderboard" }).click();
    await expect(b.page).toHaveURL(new RegExp(`/exams/${exam.examId}/leaderboard$`));
    await a.page.goto(`/groups/${gid}?tab=exams`);
    await expect(a.page.getByRole("link", { name: "Create group exam" })).toHaveAttribute("href", `/exams/new?mode=GROUP&groupId=${gid}`);
    await expect(b.page.getByRole("link", { name: "Create group exam" })).toHaveCount(0);
    await a.ctx.close();
    await b.ctx.close();
  });
});

test.describe("accessibility and layout", () => {
  test("groups, group tabs, invitations, join and leaderboard have no serious axe violations", async ({ browser }) => {
    const { a, b, gid, exam } = await seedClass(browser);
    const { code } = await createInvite(a.page, gid, { expiresInHours: 24, maxUses: 3 });
    await a.page.goto("/groups");
    await a11y(a.page, "/groups");
    await a.page.getByRole("button", { name: "New group" }).click();
    await a11y(a.page, "/groups (dialog)");
    await a.page.keyboard.press("Escape");
    for (const t of ["overview", "members", "invites", "exams", "settings"]) {
      await a.page.goto(`/groups/${gid}?tab=${t}`);
      await a11y(a.page, `/groups/:id?tab=${t}`);
    }
    await a.page.goto(`/groups/${gid}?tab=invites`);
    await a.page.getByRole("button", { name: "New invitation" }).click();
    await a.page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
    await expect(a.page.getByTestId("invite-created")).toBeVisible();
    await a11y(a.page, "invite created panel");
    await a.page.goto("/join");
    await a11y(a.page, "/join");
    const c = await newUser(browser);
    await c.page.goto(`/join/${code}`);
    await expect(c.page.getByTestId("join-group-title")).toBeVisible();
    await a11y(c.page, "/join/:code");
    await b.page.goto(`/exams/${exam.examId}/leaderboard`);
    await expect(b.page.getByTestId("leaderboard-row").first()).toBeVisible();
    await a11y(b.page, "leaderboard");
    for (const u of [a, b, c]) await u.ctx.close();
  });

  test("keyboard: arrow keys move between group tabs and the leave dialog is operable by keyboard", async ({ browser }) => {
    const a = await newUser(browser);
    const b = await newUser(browser);
    const gid = await createGroup(a.page, { title: "Keyboard club" });
    await joinViaApi(b.page, (await createInvite(a.page, gid)).code);
    await b.page.goto(`/groups/${gid}`);
    await tab(b.page, "Overview").focus();
    await b.page.keyboard.press("ArrowRight");
    await expect(tab(b.page, "Members")).toHaveAttribute("aria-selected", "true");
    await tab(b.page, "Overview").click();
    await b.page.getByRole("button", { name: "Leave group" }).focus();
    await b.page.keyboard.press("Enter");
    await expect(b.page.getByRole("dialog")).toBeVisible();
    await b.page.keyboard.press("Escape");
    await expect(b.page.getByRole("dialog")).toHaveCount(0);
    await a.ctx.close();
    await b.ctx.close();
  });

  test("no horizontal scrolling on a phone", async ({ browser }) => {
    const { a, gid, exam } = await seedClass(browser);
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, extraHTTPHeaders: { "x-forwarded-for": "198.51.77.7" } });
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel("Email").fill(a.email);
    await p.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await p.getByRole("button", { name: "Sign in" }).click();
    await expect(p).toHaveURL(/\/workspace/);
    for (const path of ["/groups", `/groups/${gid}`, `/groups/${gid}?tab=members`, `/groups/${gid}?tab=invites`, `/groups/${gid}?tab=exams`, `/groups/${gid}?tab=settings`, `/exams/${exam.examId}/leaderboard`, "/join"]) {
      await p.goto(path);
      await expect(p.getByRole("main")).toBeVisible();
      await noOverflow(p);
    }
    await ctx.close();
    await a.ctx.close();
  });
});

