// clyde update: Plugin und CLI aktualisieren (Befehle werden simuliert)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLYDE_QUIET = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clyde-update-'));
process.env.CLYDE_HOME = path.join(tmp, 'clydehome');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const fakeClaude = path.join(tmp, 'claude.exe');
fs.writeFileSync(fakeClaude, '');
process.env.CLAUDE_CODE_EXECPATH = fakeClaude;

const { createServer } = await import('../server/server.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { update, devInstall } = await import('../src/update.js');
const { versionNotes, installedPluginVersion, CLIENT_VERSION } = await import('../src/version.js');

const server = createServer({ dataDir: path.join(tmp, 'server'), token: 't', gcGraceMs: 0, log: { log() {}, error: console.error } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
saveConfig({ server: `http://127.0.0.1:${server.address().port}`, token: 't' });
const cfg = loadConfig();
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

const pluginsFile = path.join(tmp, 'claude', 'plugins', 'installed_plugins.json');
const setPlugin = (version) => {
  fs.mkdirSync(path.dirname(pluginsFile), { recursive: true });
  fs.writeFileSync(pluginsFile, JSON.stringify({ version: 2, plugins: { 'clyde@clyde': [{ scope: 'user', version }], 'andere@x': [{ version: '9.9.9' }] } }));
};
// Simulierte Befehle: merkt sich die Aufrufe, "claude plugin update" setzt die Version
function fakeRunner(to, { confirm = false } = {}) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([path.basename(cmd), ...args]);
    if (args[0] === 'plugin' && args[1] === 'update') {
      if (confirm) return { ok: false, out: JSON.stringify({ shownCommand: { sha256: 'x' } }), err: '' };
      setPlugin(to);
      return { ok: true, out: JSON.stringify({ ok: true }), err: '' };
    }
    return { ok: true, out: '', err: '' };
  };
  return { calls, runner };
}

test('Plugin-Version wird aus Claudes Plugin-Liste gelesen und in den Hinweisen genannt', () => {
  setPlugin('0.4.1');
  assert.equal(installedPluginVersion(), '0.4.1');
  const v = versionNotes({ version: CLIENT_VERSION }, CLIENT_VERSION);
  assert.ok(v.notes.some((n) => n.text.includes('Plugin in der App ist veraltet') && n.text.includes('clyde update')), JSON.stringify(v.notes));
  setPlugin(CLIENT_VERSION);
  assert.deepEqual(versionNotes({ version: CLIENT_VERSION }, CLIENT_VERSION).notes, []);
});

test('update --check aendert nichts; ohne --yes und ohne Terminal wird nichts ausgefuehrt', async () => {
  setPlugin('0.4.1');
  const { calls, runner } = fakeRunner('99.0.0');
  const plan = await update(cfg, { check: true, latest: '99.0.0', runner }, quiet);
  assert.deepEqual(plan.actions.map((a) => a.what).sort(), ['cli', 'plugin']);
  await assert.rejects(update(cfg, { noAsk: true, latest: '99.0.0', runner }, quiet), /--yes/);
  assert.equal(calls.length, 0);
});

test('update --yes aktualisiert erst das Plugin, dann das CLI', async () => {
  setPlugin('0.4.1');
  const { calls, runner } = fakeRunner('99.0.0');
  await update(cfg, { yes: true, latest: '99.0.0', runner, dev: false }, quiet);
  assert.deepEqual(calls[0], ['claude.exe', 'plugin', 'marketplace', 'update', 'clyde']);
  assert.deepEqual(calls[1], ['claude.exe', 'plugin', 'update', 'clyde@clyde', '--json']);
  assert.deepEqual(calls[2].slice(1), ['install', '-g', 'github:Gardosen/clyde#v99.0.0'], 'CLI zuletzt');
  assert.equal(installedPluginVersion(), '99.0.0');
});

test('Entwicklungsinstallation (npm link) wird nie ueberschrieben', async () => {
  setPlugin('99.0.0');
  const { calls, runner } = fakeRunner('99.0.0');
  const r = await update(cfg, { yes: true, latest: '99.0.0', runner, dev: true }, quiet);
  assert.ok(r.actions.find((a) => a.what === 'cli').skip.includes('Entwicklungsinstallation'));
  assert.equal(calls.length, 0);
  assert.equal(typeof devInstall(), 'boolean');
});

test('verlangt der Marketplace eine Befehls-Bestaetigung, bestaetigt Clyde nichts selbst', async () => {
  setPlugin('0.4.1');
  const { calls, runner } = fakeRunner('99.0.0', { confirm: true });
  const r = await update(cfg, { yes: true, latest: '99.0.0', runner }, quiet);
  const p = r.results.find((x) => x.what === 'plugin');
  assert.equal(p.ok, false);
  assert.ok(p.text.includes('in der App'));
  assert.ok(!calls.some((c) => c.includes('-y') || c.includes('--yes') || c.includes('--accept-command')));
});

test('alles aktuell: nichts zu tun; ungueltige Zielversion wird abgelehnt', async () => {
  setPlugin(CLIENT_VERSION);
  const { calls, runner } = fakeRunner(CLIENT_VERSION);
  const r = await update(cfg, { yes: true, latest: CLIENT_VERSION, runner }, quiet);
  assert.deepEqual(r.actions, []);
  assert.equal(calls.length, 0);
  await assert.rejects(update(cfg, { yes: true, args: ['1.0.0 & calc'], latest: CLIENT_VERSION, runner }, quiet), /Ungueltige Version/);
});
