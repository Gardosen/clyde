// clyde update: Clyde-Plugin in der App und Clyde-CLI auf die neueste Version
// von GitHub bringen.
//
// - Neueste Version: Tags des Repos github.com/Gardosen/clyde (git ls-remote,
//   sonst GitHub-API). Das ist der einzige Kontakt zu GitHub und nur bei
//   "clyde update".
// - Plugin: ueber Claudes eigenes CLI ("claude plugin marketplace update clyde",
//   "claude plugin update clyde@clyde"). Verlangt der Marketplace dabei die
//   Bestaetigung eines Befehls, bestaetigt Clyde nichts selbst, sondern verweist
//   auf die App.
// - CLI: npm install -g github:Gardosen/clyde#vX, als letzter Schritt (ersetzt die
//   laufenden Dateien). Eine Entwicklungsinstallation (npm link auf einen
//   Git-Arbeitsbaum) wird nie ueberschrieben.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from './client.js';
import { git } from './repos.js';
import { storeAppRoamingDirs } from './paths.js';
import { CLIENT_VERSION, PLUGIN_ID, cmpVersion, isVersion, installedPluginVersion } from './version.js';

const REPO = 'https://github.com/Gardosen/clyde.git';
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TAG = /^\d+\.\d+\.\d+$/;

// Befehl ausfuehren; .cmd/.bat (npm unter Windows) nur ueber die Shell, mit
// gequoteten, vorher gepruefte Argumenten
export function run(cmd, args, { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' && (/\.(cmd|bat)$/i.test(cmd) || !/[\\/]/.test(cmd));
    const q = (s) => (/^[\w@#:./\\=-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '')}"`);
    const done = (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    if (shell) execFile(`${q(cmd)} ${args.map(q).join(' ')}`, { shell: true, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, done);
    else execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, done);
  });
}

// Neueste Version (hoechster Tag vX.Y.Z)
export async function latestRelease() {
  const r = await git(['ls-remote', '--tags', '--refs', REPO], { timeout: 30000 });
  let tags = r.ok ? r.out.split('\n').map((l) => (l.split('refs/tags/v')[1] || '').trim()) : [];
  if (!tags.length) {
    tags = await new Promise((resolve) => {
      https.get('https://api.github.com/repos/Gardosen/clyde/tags?per_page=100', { headers: { 'user-agent': 'clyde-update', accept: 'application/vnd.github+json' }, timeout: 20000 }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { try { resolve(JSON.parse(body).map((t) => String(t.name || '').replace(/^v/, ''))); } catch { resolve([]); } });
      }).on('error', () => resolve([])).on('timeout', function () { this.destroy(); resolve([]); });
    });
  }
  return tags.filter((t) => TAG.test(t)).sort(cmpVersion).pop() || null;
}

// Claudes CLI: aus dem Chat der App (CLAUDE_CODE_EXECPATH), im PATH oder das
// von der Desktop-App mitgebrachte
export async function claudeExec() {
  if (process.env.CLAUDE_CODE_EXECPATH && fs.existsSync(process.env.CLAUDE_CODE_EXECPATH)) return process.env.CLAUDE_CODE_EXECPATH;
  const w = await run(process.platform === 'win32' ? 'where' : 'which', ['claude'], { timeout: 10000 });
  const first = w.ok ? w.out.split(/\r?\n/).find(Boolean) : null;
  if (first && fs.existsSync(first)) return first;
  const appDirs = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Application Support', 'Claude')]
    : [...storeAppRoamingDirs(), path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')];
  for (const d of appDirs) {
    const cc = path.join(d, 'claude-code');
    let vers = [];
    try { vers = fs.readdirSync(cc).filter(isVersion).sort(cmpVersion); } catch { continue; }
    for (const v of vers.reverse()) {
      const exe = path.join(cc, v, process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Laeuft dieses Clyde aus einem Git-Arbeitsbaum (npm link)?
export const devInstall = () => fs.existsSync(path.join(PACKAGE_ROOT, '.git'));

// Was ist zu tun? Liest nur.
// dev: nur fuer Tests (sonst: Git-Arbeitsbaum erkennen)
export async function planUpdate(cfg, { target, latest, dev = devInstall() } = {}) {
  const plugin = installedPluginVersion();
  let server = null;
  try { server = (await new Client(cfg.server, cfg.token).health())?.version || null; } catch { /* Server nicht erreichbar */ }
  const newest = latest ?? await latestRelease();
  const to = target || newest;
  if (!to) throw new Error('Die neueste Version liess sich nicht ermitteln (github.com nicht erreichbar?).');
  if (!TAG.test(to)) throw new Error(`Ungueltige Version: ${to}`);
  const actions = [];
  if (!plugin) actions.push({ what: 'plugin', from: null, to, skip: 'Plugin in der App nicht installiert (Customize -> Plugins: Marketplace Gardosen/clyde, Plugin clyde)' });
  else if (cmpVersion(plugin, to) < 0) actions.push({ what: 'plugin', from: plugin, to });
  if (cmpVersion(CLIENT_VERSION, to) < 0) {
    actions.push({ what: 'cli', from: CLIENT_VERSION, to, skip: dev ? `Entwicklungsinstallation (${PACKAGE_ROOT}); dort "git pull"` : undefined });
  }
  const serverNote = server && isVersion(server) && cmpVersion(server, to) < 0
    ? `Der Server laeuft mit ${server}. Server aktualisieren: auf dem Server im Clyde-Ordner git pull, dann docker compose up -d --build`
    : null;
  return { client: CLIENT_VERSION, plugin, server, latest: newest, target: to, actions, serverNote };
}

async function updatePlugin(runner, log) {
  const exe = await claudeExec();
  if (!exe) return { ok: false, text: 'Claudes CLI nicht gefunden. Plugin in der App aktualisieren: Customize -> Plugins -> clyde.' };
  log.info('Plugin: Marketplace "clyde" auffrischen ...');
  const m = await runner(exe, ['plugin', 'marketplace', 'update', 'clyde']);
  if (!m.ok) return { ok: false, text: `Marketplace-Update fehlgeschlagen: ${(m.err || m.out).split('\n').pop()}` };
  log.info(`Plugin: ${PLUGIN_ID} aktualisieren ...`);
  const u = await runner(exe, ['plugin', 'update', PLUGIN_ID, '--json']);
  let j = null;
  try { j = JSON.parse(u.out.split('\n').filter(Boolean).pop()); } catch { /* kein JSON */ }
  if (j?.shownCommand) return { ok: false, text: 'Der Marketplace verlangt die Bestaetigung eines Befehls; Clyde bestaetigt das nicht selbst. Bitte in der App aktualisieren: Customize -> Plugins -> clyde.' };
  if (!u.ok) return { ok: false, text: `Plugin-Update fehlgeschlagen: ${(u.err || u.out).split('\n').pop()}` };
  return { ok: true, text: `Plugin aktualisiert auf ${installedPluginVersion() || 'die neueste Version'}.` };
}

async function updateCli(to, runner, log) {
  log.info(`CLI: npm install -g github:Gardosen/clyde#v${to} ...`);
  const r = await runner(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', `github:Gardosen/clyde#v${to}`]);
  if (!r.ok) {
    const hint = /EACCES|permission/i.test(r.err) ? ' (keine Schreibrechte fuer globale npm-Pakete; npm-Praefix im Benutzerordner einrichten oder den Befehl selbst mit passenden Rechten ausfuehren)' : '';
    return { ok: false, text: `CLI-Update fehlgeschlagen: ${r.err.split('\n').filter(Boolean).pop() || 'unbekannter Fehler'}${hint}` };
  }
  return { ok: true, text: `CLI aktualisiert auf ${to}.` };
}

async function ttyAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// clyde update [--check] [--json] [--yes] [VERSION]
export async function update(cfg, opts, log) {
  const plan = await planUpdate(cfg, { target: opts.args?.[0], latest: opts.latest, ...(opts.dev !== undefined ? { dev: opts.dev } : {}) });
  const todo = plan.actions.filter((a) => !a.skip);
  if (opts.json && (opts.check || opts.dryRun)) { process.stdout.write(`${JSON.stringify(plan, null, 1)}\n`); return plan; }
  log.info(`Neueste Version ${plan.latest || '?'}; hier: CLI ${plan.client}, Plugin ${plan.plugin || 'nicht installiert'}; Server ${plan.server || 'unbekannt'}.`);
  for (const a of plan.actions) log.info(`  ${a.what === 'cli' ? 'CLI' : 'Plugin'}: ${a.from || '-'} -> ${a.to}${a.skip ? ` (uebersprungen: ${a.skip})` : ''}`);
  if (plan.serverNote) log.warn(plan.serverNote);
  if (!todo.length) { log.info(plan.actions.length ? 'Nichts automatisch zu aktualisieren.' : 'Alles aktuell.'); return { ...plan, results: [] }; }
  if (opts.check || opts.dryRun) { log.info('Nur geprueft, nichts geaendert. Aktualisieren: clyde update'); return plan; }
  if (!opts.yes) {
    const ask = opts.ask || (opts.noAsk || !process.stdin.isTTY ? null : ttyAsk);
    if (!ask) throw new Error('Nichts geaendert. Mit --yes bestaetigen (oder /clyde:update in der App).');
    if (!['j', 'ja', 'y', 'yes'].includes(String(await ask('Aktualisieren? [j/N] ')).trim().toLowerCase())) { log.info('Abgebrochen.'); return plan; }
  }
  const runner = opts.runner || run;
  const results = [];
  // Plugin zuerst: das CLI-Update ersetzt die Dateien dieses laufenden Programms
  for (const a of todo.filter((x) => x.what === 'plugin')) results.push({ what: 'plugin', ...(await updatePlugin(runner, log)) });
  for (const a of todo.filter((x) => x.what === 'cli')) results.push({ what: 'cli', ...(await updateCli(a.to, runner, log)) });
  for (const r of results) { if (r.ok) log.info(r.text); else log.warn(r.text); }
  if (results.some((r) => r.what === 'plugin' && r.ok)) log.info('Neue und geaenderte Befehle des Plugins gibt es in neuen Chats (sicher nach einem Neustart der App).');
  return { ...plan, results };
}
