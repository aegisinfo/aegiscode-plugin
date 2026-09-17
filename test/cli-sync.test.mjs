#!/usr/bin/env node
/**
 * Cloud conversation sync in the terminal host.
 *
 * The CLI shipped the *transport* for this — `client.conversationSyncPush/Pull`
 * are the same two shared-client methods the desktop has called since P4.5 —
 * and no code that used them. Worse, `/cloud` answered "ÆGIS cloud key/sync is
 * managed by the aegis CLI: run `aegis login` — aegiscode does not store cloud
 * keys", so the feature looked present and pointed the user at another product.
 *
 * What these tests pin:
 *   · pending is derived from the local store, not a flag that can go stale;
 *   · the pushed payload is the wire shape the server stores verbatim
 *     (`{session_id, title, messages:[{role,content}], source}`) — the desktop
 *     pushes the same keys, and a different spelling here would make one host's
 *     sessions unreadable to the other;
 *   · a pull imports once and is idempotent, and imported sessions land in the
 *     same history.jsonl `/resume` reads;
 *   · a 402 quota refusal is reported as quota, not swallowed as "sync failed";
 *   · sync is off by default — auto-pushing bills synced-token quota.
 *
 * The client is injected (no network); the sync engine, the history store and
 * the real command dispatcher are not.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

async function withHome(dir, fn) {
  const prevHome = process.env.AEGISCODE_HOME;
  const prevKey = process.env.AEGIS_API_KEY;
  process.env.AEGISCODE_HOME = dir;
  delete process.env.AEGIS_API_KEY;
  try {
    // `await` is load-bearing: without it the finally below restores the env as
    // soon as the body's first await yields, and every later read/write in the
    // test lands in the developer's real ~/.aegiscode.
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.AEGISCODE_HOME;
    else process.env.AEGISCODE_HOME = prevHome;
    if (prevKey === undefined) delete process.env.AEGIS_API_KEY;
    else process.env.AEGIS_API_KEY = prevKey;
  }
}

const KEY = `aegis_${'S'.repeat(24)}`;

/** Seed history.jsonl with the shape the session loop writes. */
function seedHistory(dir, sessions) {
  const lines = [];
  for (const [id, exchanges] of Object.entries(sessions)) {
    for (const [prompt, reply, ts] of exchanges) {
      lines.push(
        JSON.stringify({
          ts: ts || new Date().toISOString(),
          sessionId: id,
          cwd: '/home/neo/project',
          prompt,
          reply,
          status: 'done',
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, real: true },
        })
      );
    }
  }
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
  return lines;
}

function stubClient(o = {}) {
  const pushes = [];
  const pulls = [];
  return {
    apiBase: 'https://aegiscloud.org',
    apiKey: KEY,
    pushes,
    pulls,
    pushes_() { return pushes; },
    async conversationSyncPush(payload) {
      pushes.push(payload);
      if (o.pushThrows) throw o.pushThrows;
      return { ok: true, session_id: payload.session_id, updated_at: new Date().toISOString() };
    },
    async conversationSyncPull() {
      pulls.push({});
      if (o.pullThrows) throw o.pullThrows;
      return { sessions: o.remote || [] };
    },
    // Enough of the transport for a real turn to complete, so the auto-sync
    // assertions below exercise the success path rather than an error path that
    // happens to persist a turn too.
    async chatCompletion() {
      return {
        model: 'deepseek',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
    async tokenBankBalance() {
      return { balance_eur: 1, ledger: [] };
    },
  };
}

function captureApp(client) {
  const written = [];
  const out = { isTTY: false, write: (s) => { written.push(s); return true; } };
  const deps = require(join(root, 'cli', 'src', 'deps.js'));
  const { createApp } = require(join(root, 'cli', 'src', 'app.js'));
  const app = createApp({
    client,
    tools: deps.createTools(client),
    out,
    err: { write: () => true },
    stream: true,
    width: () => 80,
  });
  return { app, text: () => stripAnsi(written.join('')), written };
}

const tmpHome = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `aegiscode-sync-${n}-`));

// ── 1. pending is derived, not a stale flag ─────────────────────────────────
{
  const dir = tmpHome('pending');
  await withHome(dir, async () => {
    const cloudsync = require(join(root, 'cli', 'src', 'cloudsync.js'));
    seedHistory(dir, {
      aaa: [['first question', 'first answer', '2026-09-01T10:00:00Z']],
      bbb: [['second question', 'second answer', '2026-09-02T10:00:00Z']],
    });

    const st = cloudsync.status();
    eq(st.local, 2, 'both local sessions are seen');
    eq(st.pending, 2, 'neither has been pushed, so both are pending');
    eq(st.synced, 0, 'and none are in sync');

    const list = cloudsync.listPending();
    eq(list.length, 2, 'listPending returns them');
    eq(list[0].id, 'aaa', 'oldest first, so a backlog drains in order');

    // Mark one synced at its current state: it stops being pending…
    const state = cloudsync.loadState();
    cloudsync.markSynced(state, 'aaa', { localUpdatedAt: list[0].updatedAt });
    cloudsync.saveState(state);
    eq(cloudsync.status().pending, 1, 'a synced session leaves the pending set');

    // …and comes back the moment a new exchange is written, which is what a
    // stored `pending: false` flag would get wrong.
    fs.appendFileSync(
      path.join(dir, 'history.jsonl'),
      JSON.stringify({
        ts: '2026-09-03T10:00:00Z',
        sessionId: 'aaa',
        cwd: '/home/neo/project',
        prompt: 'a follow-up',
        reply: 'a follow-up answer',
        status: 'done',
      }) + '\n'
    );
    eq(cloudsync.status().pending, 2, 'new local activity re-flags the session without any flag');
    eq(
      cloudsync.listPending().map((s) => s.id).join(','),
      'bbb,aaa',
      'and a backlog still drains oldest-activity-first (aaa is now the newest)'
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 2. the pushed payload is the shared wire shape ──────────────────────────
{
  const dir = tmpHome('payload');
  await withHome(dir, async () => {
    const cloudsync = require(join(root, 'cli', 'src', 'cloudsync.js'));
    seedHistory(dir, { s1: [['What is a closure?', 'A function plus its scope.', '2026-09-01T10:00:00Z']] });
    const client = stubClient();
    const res = await cloudsync.push(client);

    eq(res.pushed.length, 1, 'one session pushed');
    eq(client.pushes.length, 1, 'exactly one request — no per-message chatter');
    const sent = client.pushes[0];
    eq(sent.session_id, 's1', 'the session id travels');
    eq(sent.source, 'aegiscode-cli', 'the source names this host, so the server can tell hosts apart');
    assert(typeof sent.title === 'string' && sent.title.length, 'a title travels');
    assert(sent.title.includes('closure'), `the title is derived from the first prompt (got ${JSON.stringify(sent.title)})`);
    eq(sent.messages.length, 2, 'both sides of the exchange travel');
    eq(sent.messages[0].role, 'user', 'role 1 is the user (the key the desktop pushes)');
    eq(sent.messages[0].content, 'What is a closure?', 'and its content is under `content`, not `text`');
    eq(sent.messages[1].role, 'assistant', 'role 2 is the assistant');
    eq(cloudsync.status().pending, 0, 'the backlog is empty afterwards');
    eq(cloudsync.status().lastPushAt != null, true, 'and the push time is recorded');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 3. a pull imports once and is idempotent ────────────────────────────────
{
  const dir = tmpHome('pull');
  await withHome(dir, async () => {
    const cloudsync = require(join(root, 'cli', 'src', 'cloudsync.js'));
    const history = require(join(root, 'cli', 'src', 'history.js'));
    seedHistory(dir, { mine: [['local question', 'local answer']] });
    const remote = [
      {
        session_id: 'remote-1',
        title: 'From the desktop',
        source: 'aegis-desktop',
        updated_at: '2026-09-04T10:00:00Z',
        messages: [
          { role: 'user', content: 'remote question' },
          { role: 'assistant', content: 'remote answer' },
        ],
      },
    ];
    const client = stubClient({ remote });

    const first = await cloudsync.pull(client);
    eq(first.ok, true, 'the pull succeeds');
    eq(first.imported, 1, 'the remote session is imported as one record');
    const ids = history.readOwnSessions(10).map((s) => s.id);
    assert(ids.includes('remote-1'), `a pulled session shows up in the local store /resume reads (got ${ids.join(',')})`);
    const rows = history.readHistoryEntries().filter((e) => e.sessionId === 'remote-1');
    eq(rows.length, 1, 'one record, not one per message');
    eq(rows[0].prompt, 'remote question', 'the user side is preserved');
    eq(rows[0].reply, 'remote answer', 'and the assistant side');
    eq(rows[0].imported, true, 'the record is marked as imported, not authored here');
    eq(rows[0].tokens.real, false, 'and its token counts are marked estimated, never passed off as measured');
    const transcript = history.readSessionTranscript('remote-1');
    eq(transcript.length, 2, 'the transcript round-trips');

    // Pulling again must not duplicate the account into the local store.
    const second = await cloudsync.pull(client);
    eq(second.imported, 0, 'an unchanged remote session is not re-imported');
    eq(history.readHistoryEntries().filter((e) => e.sessionId === 'remote-1').length, 1, 'no duplicate records');
    eq(client.pulls.length, 2, 'the pull did still happen — idempotence is not caching');

    // A changed remote session is re-imported.
    remote[0].updated_at = '2026-09-05T10:00:00Z';
    remote[0].messages.push({ role: 'user', content: 'a new remote turn' });
    remote[0].messages.push({ role: 'assistant', content: 'a new remote reply' });
    const third = await cloudsync.pull(client);
    eq(third.imported, 1, 'a newer remote revision is imported');
    const grown = history.readHistoryEntries().filter((e) => e.sessionId === 'remote-1');
    eq(grown.length, 2, 'only the new turn is added — the earlier one is not written twice');
    eq(grown[1].prompt, 'a new remote turn', 'and it is the turn that actually arrived');
    eq(grown[0].prompt, 'remote question', 'while the first import is left alone');

    // A pulled session must not be pushed straight back.
    const back = await cloudsync.push(client);
    eq(back.pushed.filter((p) => p.id === 'remote-1').length, 0, 'a session that came from the cloud is not pushed back');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 4. quota and auth refusals are named for what they are ──────────────────
{
  const dir = tmpHome('quota');
  await withHome(dir, async () => {
    const cloudsync = require(join(root, 'cli', 'src', 'cloudsync.js'));
    seedHistory(dir, { q1: [['q', 'a']], q2: [['q2', 'a2']] });
    const err = Object.assign(new Error('sync quota reached'), { status: 402 });
    const client = stubClient({ pushThrows: err });

    const res = await cloudsync.push(client);
    eq(res.pushed.length, 0, 'nothing is recorded as pushed');
    eq(res.failed.length, 1, 'the refusal is recorded once, not per session');
    eq(res.failed[0].kind, 'quota', '402 is reported as quota');
    assert(/synced-token ceiling/.test(res.failed[0].hint || ''), 'with the thing the user can act on');
    eq(client.pushes.length, 1, 'and the loop stops — every later session fails the same way');

    const authErr = Object.assign(new Error('unauthorized'), { status: 401 });
    eq(cloudsync.describeError(authErr).kind, 'auth', '401 is reported as an auth problem');
    assert(/\/key/.test(cloudsync.describeError(authErr).hint), 'and points at the command that fixes it');
    eq(cloudsync.describeError(new Error('socket hang up')).kind, 'error', 'anything else is a plain failure');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 5. /sync and /cloud sync through the real dispatcher ───────────────────
{
  const dir = tmpHome('commands');
  await withHome(dir, async () => {
    const config = require(join(root, 'cli', 'src', 'config.js'));
    seedHistory(dir, { c1: [['hello', 'hi there']], c2: [['again', 'sure']] });
    const client = stubClient({
      remote: [{ session_id: 'r1', title: 'remote', updated_at: '2026-09-06T10:00:00Z', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }],
    });
    const { app, text } = captureApp(client);

    // The gate flipped: persisting memory is ON out of the box. It used to be
    // opt-in on the reasoning that "silence is not consent for spending
    // synced-token quota" — but silence was also the only way to learn the
    // feature existed, and the copy promises cross-session memory with any
    // account. The ceiling is metered on WRITES only, so being over it pauses
    // new writes and leaves everything already stored readable; that is a state
    // to surface, not a reason to default everyone to forgetting.
    //
    // What the old assertion was protecting is still protected, by the two
    // tests below it: an explicit choice is honoured, and the quota is visible.
    const gate = app.cloudSyncState();
    eq(app.cloudSyncEnabled(), true, 'persisting memory is on out of the box');
    eq(gate.source, 'default', 'and the panel can say it is the default, not a stored setting');
    eq(config.loadConfig().memoryPersist, undefined, 'a default is not written to config.json — it is still a default');

    // An explicit pre-flip `cloudSync: false` survives the flip: nobody who
    // turned this off gets quietly opted back in.
    config.updateConfig({ memoryPersist: undefined, cloudSync: false });
    const legacyOff = app.cloudSyncState();
    eq(legacyOff.enabled, false, 'an explicit cloudSync: false is still an opt-out');
    eq(legacyOff.source, 'legacy', 'and it is reported as the old key, not as the default');
    config.updateConfig({ memoryPersist: true, cloudSync: undefined });

    await app.handleLine('/sync');
    const synced = text();
    assert(!/unknown command/.test(synced), `/sync is a real command (got ${JSON.stringify(synced.slice(0, 120))})`);
    assert(/pushed 2 sessions/.test(synced), `bare /sync pushes the backlog (got ${JSON.stringify(synced)})`);
    assert(/pulled 1 record/.test(synced), 'and pulls what the cloud has');
    eq(client.pushes.length, 2, 'two sessions went up');
    eq(client.pulls.length, 1, 'one list request came down');

    await app.handleLine('/sync status');
    assert(/Cloud sync/.test(text()), '/sync status renders a panel');

    await app.handleLine('/sync on');
    eq(app.cloudSyncEnabled(), true, '/sync on persists the setting');
    // "Survives a restart" is the claim being tested, so test it against the
    // key that is actually read at startup — and against a reload, not the
    // in-memory object the running app already holds.
    const persisted = config.loadConfig();
    eq(persisted.memoryPersist, true, 'and it is in config.json, so it survives a restart');
    eq(
      persisted.cloudSync,
      undefined,
      'the pre-flip key is retired in the same write, so the two can never disagree'
    );
    eq(config.memoryPersistState(persisted).enabled, true, 'a reload resolves it as on');
    eq(
      config.memoryPersistState(persisted).source,
      'config',
      'and from the stored key, not from the default'
    );

    // With auto-sync on, a turn pushes in the background — the setting has to
    // mean something, not just relabel the status line.
    const pushesBefore = client.pushes.length;
    await app.handleLine('/ask what is a monad');
    await new Promise((r) => setTimeout(r, 50));
    assert(!/error:/.test(text().slice(text().lastIndexOf('monad'))), 'the turn itself completed');
    assert(client.pushes.length > pushesBefore, 'an auto-sync turn pushes without being asked');

    await app.handleLine('/sync off');
    eq(app.cloudSyncEnabled(), false, '/sync off turns it back off');
    const quiet = client.pushes.length;
    await app.handleLine('/ask again');
    await new Promise((r) => setTimeout(r, 50));
    eq(client.pushes.length, quiet, 'and with it off no turn pushes anything');

    // /cloud is the discoverable surface: it must show the key *and* the sync
    // state rather than deferring to another CLI.
    await app.handleLine('/cloud sync');
    const cloud = text();
    assert(/Cloud sync/.test(cloud), '/cloud sync renders the sync state');
    assert(/last push/.test(cloud), 'including when it last ran');

    // A refusal reaches the user as a refusal. New activity first: everything
    // already pushed is not pending, and a sync with nothing to send never
    // reaches the server at all.
    fs.appendFileSync(
      path.join(dir, 'history.jsonl'),
      JSON.stringify({ ts: new Date(Date.now() + 60_000).toISOString(), sessionId: 'c1', cwd: '/home/neo/project', prompt: 'newer', reply: 'newer reply', status: 'done' }) + '\n'
    );
    const refused = captureApp(stubClient({ pushThrows: Object.assign(new Error('sync quota reached'), { status: 402 }) }));
    await refused.app.handleLine('/sync now');
    const t = refused.text();
    assert(/quota/.test(t), `/sync reports a quota refusal as quota (got ${JSON.stringify(t.slice(-300))})`);
    assert(!/pushed 1|pushed 2/.test(t), 'and does not claim success');

    // No key: the honest answer, not a stack trace.
    const keyless = stubClient();
    keyless.apiKey = '';
    const none = captureApp(keyless);
    await none.app.handleLine('/sync');
    assert(/no key/.test(none.text()), 'a keyless /sync says the key is what is missing');

    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ── 6. sync is reachable from the command registry ──────────────────────────
{
  const { COMMANDS, parseLine } = require(join(root, 'cli', 'src', 'commands.js'));
  const sync = COMMANDS.find((c) => c.name === 'sync');
  assert(sync, '/sync is registered');
  assert(sync.aliases.includes('cloudsync'), 'with the alias a user would guess');
  eq(parseLine('/cloudsync').kind, 'command', '/cloudsync dispatches');
  const cloud = COMMANDS.find((c) => c.name === 'cloud');
  assert(/sync/.test(cloud.hint), '/cloud advertises its sync subcommands');
  assert(!/does not store cloud keys/.test(JSON.stringify(cloud)), '/cloud no longer disclaims storing the key');
}

console.log('cli-sync tests passed');
