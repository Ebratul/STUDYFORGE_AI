import { randomUUID } from "node:crypto";
import { getAuth } from "../../src/auth/auth.js";
import { db } from "../../src/lib/db.js";

export const TEST_PASSWORD = "Correct-horse-battery-9";
export const TEST_ORIGIN = "http://localhost:3100";

export type TestUser = { id: string; email: string; name: string; headers: Headers };

function cookieHeaderFrom(res: Headers): Headers {
  const cookie = res
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  return new Headers({ cookie });
}

export async function createUser(overrides: { name?: string; email?: string } = {}): Promise<TestUser> {
  const email = overrides.email ?? `user-${randomUUID()}@example.test`;
  const name = overrides.name ?? "Test User";
  const auth = getAuth();
  const signUp = await auth.api.signUpEmail({ body: { name, email, password: TEST_PASSWORD } });
  const signIn = await auth.api.signInEmail({ body: { email, password: TEST_PASSWORD }, returnHeaders: true });
  return { id: signUp.user.id, email, name, headers: cookieHeaderFrom(signIn.headers) };
}

export async function signInAgain(user: Pick<TestUser, "email">): Promise<Headers> {
  const res = await getAuth().api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD }, returnHeaders: true });
  return cookieHeaderFrom(res.headers);
}

export async function makeAdmin(userId: string) {
  await db.user.update({ where: { id: userId }, data: { role: "ADMIN" } });
}
