// Versionen von Clyde auf diesem PC und auf dem Server vergleichen.
//
// Der Server meldet unter /health seine Version und (ab 0.4.7) die aelteste
// Client-Version, mit der er sicher arbeitet (minClient). Umgekehrt kennt der
// Client die aelteste Server-Version, die er braucht (MIN_SERVER).
import fs from 'node:fs';

export const CLIENT_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
})();
// Staende im Format v3 (maskierte Platzhalter) speichert der Server ab 0.4.2
export const MIN_SERVER = '0.4.2';

const parts = (v) => String(v || '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
export function cmpVersion(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
const isVersion = (v) => /^\d+\.\d+\.\d+/.test(String(v || ''));

const SERVER_UPDATE = 'auf dem Server im Clyde-Ordner: git pull, dann docker compose up -d --build';

// Hinweise zum Versionsstand. level: 'block' (dieser Client darf nicht weiter),
// 'warn' (sollte aktualisiert werden)
export function versionNotes(health, client = CLIENT_VERSION) {
  const server = health?.version;
  const notes = [];
  if (!isVersion(server)) return { client, server: server || null, notes };
  const clientUpdate = `npm install -g github:Gardosen/clyde#v${server} (und das Plugin in der App aktualisieren)`;
  if (isVersion(health.minClient) && cmpVersion(client, health.minClient) < 0) {
    notes.push({ level: 'block', text: `Dieses Clyde (${client}) ist zu alt fuer den Server, er braucht mindestens ${health.minClient}. Aktualisieren: ${clientUpdate}` });
  } else if (cmpVersion(client, server) < 0) {
    notes.push({ level: 'warn', text: `Dieses Clyde ist veraltet: auf dem Server laeuft ${server}, hier ${client}. Aktualisieren: ${clientUpdate}` });
  }
  if (cmpVersion(server, MIN_SERVER) < 0) {
    notes.push({ level: 'warn', text: `Der Server (${server}) ist zu alt fuer dieses Clyde (${client}), Push schlaegt fehl. Server aktualisieren: ${SERVER_UPDATE}` });
  } else if (cmpVersion(server, client) < 0) {
    notes.push({ level: 'warn', text: `Der Server laeuft noch mit ${server}, dieser PC mit ${client}. Server aktualisieren: ${SERVER_UPDATE}` });
  }
  return { client, server, notes };
}

// Fuer push und pull: Hinweise ausgeben, bei 'block' abbrechen
export function checkVersions(health, log) {
  const v = versionNotes(health);
  for (const n of v.notes) {
    if (n.level === 'block') throw new Error(n.text);
    log.warn(n.text);
  }
  return v;
}
