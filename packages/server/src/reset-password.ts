/**
 * `reset-password`: sets a new admin password from a shell on the server, for when it's forgotten.
 * Reading the database already means owning the server, so no old password is asked for. Every
 * session is signed out. Safe to run while the server is up (SQLite WAL).
 */
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ChangePasswordRequestSchema } from "@nslib/shared";
import { AuthService } from "./auth/auth-service";
import type { ServerConfig } from "./config";
import { openDatabase } from "./db/client";

const newPasswordSchema = ChangePasswordRequestSchema.shape.newPassword;

/** Prompts on a terminal without echoing what's typed. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(prompt);
    // Swallow the echo of what's typed; readline still sees the keys.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    let answered = false;
    rl.question("", (answer) => {
      answered = true;
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!answered) reject(new Error("No password given"));
    });
  });
}

/** The first line of piped input, for scripts: `echo "$PASSWORD" | … reset-password`. */
async function readPiped(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const line = text.split(/\r?\n/)[0] ?? "";
  if (line === "") throw new Error("No password given");
  return line;
}

export async function resetPasswordCommand(config: ServerConfig): Promise<number> {
  const interactive = process.stdin.isTTY === true;
  let password: string;
  try {
    password = interactive ? await promptHidden("New admin password: ") : await readPiped();
    if (interactive && (await promptHidden("Repeat it: ")) !== password) {
      process.stderr.write("The passwords don't match. Nothing changed.\n");
      return 1;
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const parsed = newPasswordSchema.safeParse(password);
  if (!parsed.success) {
    process.stderr.write(`${parsed.error.issues[0]?.message ?? "Invalid password"}\n`);
    return 1;
  }

  const { db, sqlite } = openDatabase(config.databaseFile ?? join(config.dataDir, "db.sqlite"));
  try {
    const username = await new AuthService(db).resetPassword(parsed.data);
    if (username === null) {
      process.stderr.write(
        "No admin account exists yet. Open the web UI to create one with the setup token.\n",
      );
      return 1;
    }
    process.stderr.write(`Password changed for ${username}. Every session was signed out.\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}
