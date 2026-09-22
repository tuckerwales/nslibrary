import { createHash, randomBytes } from "node:crypto";
import { eq, lt, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { admin, sessions } from "../db/schema";
import { hashPassword, verifyPassword } from "./passwords";

export const SESSION_COOKIE = "nslib_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

export interface ResolvedSession {
  username: string;
  expiresAt: number;
  /** True when the expiry was extended and the cookie should be re-sent. */
  renewed: boolean;
}

function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  readonly #db: Db;
  readonly #now: () => number;
  /** Compared against when no admin exists, so failed sign-ins take the same time either way. */
  #dummyHash: Promise<string> | null = null;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  isSetupRequired(): boolean {
    return this.#db.select({ id: admin.id }).from(admin).get() === undefined;
  }

  /** Creates the single admin account. Returns false if one already exists. */
  async createAdmin(username: string, password: string): Promise<boolean> {
    const passwordHash = await hashPassword(password);
    const inserted = this.#db
      .insert(admin)
      .values({ id: 1, username, passwordHash, createdAt: this.#now() })
      .onConflictDoNothing()
      .run();
    return inserted.changes > 0;
  }

  async verifyLogin(username: string, password: string): Promise<boolean> {
    const account = this.#db.select().from(admin).get();
    if (!account) {
      this.#dummyHash ??= hashPassword("not-a-real-password");
      await verifyPassword(password, await this.#dummyHash);
      return false;
    }
    const passwordOk = await verifyPassword(password, account.passwordHash);
    return passwordOk && account.username === username;
  }

  /**
   * Replaces the admin password after checking the current one, and signs out every other session
   * so a leaked cookie stops working. Returns false when the current password is wrong.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    keepSessionToken: string,
  ): Promise<boolean> {
    const account = this.#db.select().from(admin).get();
    if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) return false;
    const passwordHash = await hashPassword(newPassword);
    const keep = sessionId(keepSessionToken);
    this.#db.transaction((tx) => {
      tx.update(admin).set({ passwordHash }).where(eq(admin.id, account.id)).run();
      tx.delete(sessions).where(ne(sessions.id, keep)).run();
    });
    return true;
  }

  /**
   * Sets a new admin password without the old one, for someone with shell access to the server
   * (`reset-password`). Every session is signed out. Returns the username, or null when setup
   * hasn't happened yet.
   */
  async resetPassword(newPassword: string): Promise<string | null> {
    const account = this.#db.select().from(admin).get();
    if (!account) return null;
    const passwordHash = await hashPassword(newPassword);
    this.#db.transaction((tx) => {
      tx.update(admin).set({ passwordHash }).where(eq(admin.id, account.id)).run();
      tx.delete(sessions).run();
    });
    return account.username;
  }

  createSession(userAgent: string | undefined): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    const expiresAt = now + SESSION_TTL_MS;
    this.#db
      .insert(sessions)
      .values({
        id: sessionId(token),
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
        userAgent: userAgent?.slice(0, 256) ?? null,
      })
      .run();
    return { token, expiresAt };
  }

  resolveSession(
    token: string | undefined,
    options: { renew?: boolean } = {},
  ): ResolvedSession | null {
    if (!token) return null;
    const id = sessionId(token);
    const session = this.#db.select().from(sessions).where(eq(sessions.id, id)).get();
    const account = session && this.#db.select({ username: admin.username }).from(admin).get();
    const now = this.#now();
    if (!session || !account || session.expiresAt <= now) return null;

    const renewed = options.renew === true && session.expiresAt - now < SESSION_RENEW_BELOW_MS;
    const expiresAt = renewed ? now + SESSION_TTL_MS : session.expiresAt;
    if (renewed || now - session.lastSeenAt > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.#db
        .update(sessions)
        .set({ expiresAt, lastSeenAt: now })
        .where(eq(sessions.id, id))
        .run();
    }
    return { username: account.username, expiresAt, renewed };
  }

  deleteSession(token: string | undefined): void {
    if (token)
      this.#db
        .delete(sessions)
        .where(eq(sessions.id, sessionId(token)))
        .run();
  }

  purgeExpiredSessions(): void {
    this.#db.delete(sessions).where(lt(sessions.expiresAt, this.#now())).run();
  }
}

/** In-memory limiter for failed sign-ins per client address. */
export class LoginRateLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(maxFailures = 10, windowMs = 15 * 60 * 1000, now: () => number = Date.now) {
    this.#maxFailures = maxFailures;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #recent(key: string): number[] {
    const cutoff = this.#now() - this.#windowMs;
    const recent = (this.#failures.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, recent);
    return recent;
  }

  isLimited(key: string): boolean {
    return this.#recent(key).length >= this.#maxFailures;
  }

  recordFailure(key: string): void {
    this.#failures.set(key, [...this.#recent(key), this.#now()]);
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }
}
