import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSessionStore } from "../dist/session-store.js";

const testSession = {
  imei: "fixture-imei",
  userAgent: "fixture-agent",
  language: "en",
  cookie: [
    {
      key: "test-cookie",
      value: "fixture-value",
      domain: "zalo.me",
      path: "/",
      expires: "2099-01-01T00:00:00.000Z",
      secure: true,
      httpOnly: true,
      hostOnly: false,
    },
    { key: "empty-value-cookie", domain: "chat.zalo.me", path: "/" },
  ],
};

async function withDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), "zalo-session-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("persists just the SDK session in a private file and clears it", async (context) => {
  const directory = await withDirectory(context);
  const path = join(directory, "private", "session.json");
  const store = new FileSessionStore(path);
  assert.equal(await store.load(), null);

  await store.save({
    ...testSession,
    ignored: "unrelated-context",
    cookie: [
      { ...testSession.cookie[0], ignored: "unrelated-cookie-metadata" },
      testSession.cookie[1],
    ],
  });
  assert.deepEqual(await new FileSessionStore(path).load(), testSession);
  assert.doesNotMatch(await readFile(path, "utf8"), /unrelated-/);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

  await store.clear();
  await store.clear();
  assert.equal(await store.load(), null);
});

test("does not replace a valid session with malformed credentials", async (context) => {
  const directory = await withDirectory(context);
  const store = new FileSessionStore(join(directory, "session.json"));
  await store.save(testSession);
  await assert.rejects(
    store.save({ ...testSession, cookie: [{ value: "synthetic-secret" }] }),
    { message: "Invalid Zalo session format." },
  );
  assert.deepEqual(await store.load(), testSession);
});

test("rejects malformed JSON without echoing its contents", async (context) => {
  const directory = await withDirectory(context);
  const path = join(directory, "session.json");
  await writeFile(path, '{"session":synthetic-secret}', { mode: 0o600 });
  await assert.rejects(new FileSessionStore(path).load(), { message: "Invalid Zalo session format." });
});

test("rejects overly broad file permissions and does not follow a symlink", {
  skip: process.platform === "win32",
}, async (context) => {
  const directory = await withDirectory(context);
  const path = join(directory, "session.json");
  const target = join(directory, "target.json");
  await new FileSessionStore(target).save(testSession);
  const store = new FileSessionStore(path);

  await symlink(target, path);
  await assert.rejects(store.load(), { message: "Could not open the Zalo session file." });

  await store.save({ ...testSession, language: "vi" });
  assert.equal((await store.load()).language, "vi");
  assert.equal((await new FileSessionStore(target).load()).language, "en");

  await chmod(path, 0o644);
  await assert.rejects(store.load(), /permissions to 0600/);
});
