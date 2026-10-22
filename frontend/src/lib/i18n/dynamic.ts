/**
 * Server messages (API errors, exam checks, notifications) are written in English with the values already baked in, e.g.
 * "You've used all 3 attempts for this exam.". `createT` matches such text against these patterns when the exact string has no
 * translation and renders the translated template (`key`, listed in extra-keys.ts) with the captured values instead.
 * The first capture group is `vars[0]`, and so on; numeric captures are passed as numbers so plurals work.
 */
export type DynamicMessage = { re: RegExp; key: string; vars: string[] };

export const DYNAMIC_MESSAGES: DynamicMessage[] = [
  { re: /^An exam can have up to (\d+) questions\.$/, key: "An exam can have up to {max} questions.", vars: ["max"] },
  { re: /^A question needs (\d+)–(\d+) options\.$/, key: "A question needs {min}–{max} options.", vars: ["min", "max"] },
  { re: /^You've used all (\d+) attempts? for this exam\.$/, key: "You've used all {count, plural, one {# attempt} other {# attempts}} for this exam.", vars: ["count"] },
  { re: /^You can have up to (\d+) exams\.$/, key: "You can have up to {max} exams.", vars: ["max"] },
  { re: /^You can have up to (\d+) exams\. Delete some drafts to make room\.$/, key: "You can have up to {max} exams. Delete some drafts to make room.", vars: ["max"] },
  { re: /^A group can have up to (\d+) active invitations\. Revoke one first\.$/, key: "A group can have up to {max} active invitations. Revoke one first.", vars: ["max"] },
  { re: /^The group already has (\d+) members, so capacity can't be lower than that\.$/, key: "The group already has {count} members, so capacity can't be lower than that.", vars: ["count"] },
  { re: /^You can belong to up to (\d+) groups\.$/, key: "You can belong to up to {max} groups.", vars: ["max"] },
  { re: /^You can own up to (\d+) groups\.$/, key: "You can own up to {max} groups.", vars: ["max"] },
  // notifications (titles and bodies are stored in English by the backend)
  { re: /^“(.+)” opens at (.+) UTC\.$/s, key: "“{title}” opens at {when} UTC.", vars: ["title", "when"] },
  { re: /^Results for “(.+)” are ready\.$/s, key: "Results for “{title}” are ready.", vars: ["title"] },
  { re: /^The owner of “(.+)” deleted their account, so the group and its exams were removed\.$/s, key: "The owner of “{title}” deleted their account, so the group and its exams were removed.", vars: ["title"] },
  { re: /^You were removed from (.+)$/s, key: "You were removed from {title}", vars: ["title"] },
  { re: /^A member left (.+)$/s, key: "A member left {title}", vars: ["title"] },
  { re: /^(.+) left the group\.$/s, key: "{name} left the group.", vars: ["name"] },
  { re: /^“(.+)” was published in (.+)\.$/s, key: "“{title}” was published in {group}.", vars: ["title", "group"] },
  { re: /^“(.+)” was published\.$/s, key: "“{title}” was published.", vars: ["title"] },
  { re: /^You're invited to join (.+)$/s, key: "You're invited to join {title}", vars: ["title"] },
  { re: /^(.+) invited you to the study group “(.+)”\. This invitation is just for you\.$/s, key: "{name} invited you to the study group “{title}”. This invitation is just for you.", vars: ["name", "title"] },
  { re: /^New member in (.+)$/s, key: "New member in {title}", vars: ["title"] },
  { re: /^(.+) joined the group\.$/s, key: "{name} joined the group.", vars: ["name"] },
  { re: /^We received your answers for “(.+)”\.$/s, key: "We received your answers for “{title}”.", vars: ["title"] },
  { re: /^Time ran out on “(.+)”, so your answers were submitted automatically\.$/s, key: "Time ran out on “{title}”, so your answers were submitted automatically.", vars: ["title"] },
  { re: /^Hi (.+), your account is ready\. Document-grounded chat, MCQ\/CQ generation and exams arrive in the next parts of the build\.$/s, key: "Hi {name}, your account is ready. Document-grounded chat, MCQ/CQ generation and exams arrive in the next parts of the build.", vars: ["name"] },
];
