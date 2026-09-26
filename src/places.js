// "Wo hat der Chat sein Wissen?" je Geraet: Projektordner, zugehoeriges Repo und
// Memory-Ordner. Berechnet aus den Verweisen (refs.json) und dem neutralen
// Arbeitsordner des Chats; wird im Dashboard und von "clyde status -v" genutzt.
import { allForms, localize, pathVariants } from './rewrite.js';

const joinFor = (platform, a, b) => (b ? `${a}${platform === 'win32' ? '\\' : '/'}${platform === 'win32' ? b.split('/').join('\\') : b}` : a);
const resolved = (s) => (s && !s.includes('@@CLYDE_') ? s : null);

// canonicalCwd: neutral, RAW-Schreibweise (wie in snap.projects)
export function chatPlaces(refs, chatId, canonicalCwd) {
  const link = refs?.chats?.[chatId] || null;
  const repo = link ? refs.repos?.[link.repo] || null : null;
  const memKey = canonicalCwd ? pathVariants(canonicalCwd).KEY : null;
  const out = [];
  // Geraete: alle mit Angaben, dazu die, die nur beim Repo eingetragen sind
  const ids = [...new Set([...Object.keys(refs?.devices || {}), ...Object.keys(repo?.locations || {})])];
  for (const deviceId of ids) {
    const d = refs?.devices?.[deviceId] || { name: repo?.locations?.[deviceId]?.device };
    const forms = d.home ? allForms(d.home, d.projectDrive, d.pathMap || {}) : [];
    const loc = repo?.locations?.[deviceId] || null;
    // Liegt das Repo hier, folgt der Projektordner daraus; sonst aus den Regeln des Geraets
    const cwd = loc?.status === 'ok' && loc.path ? joinFor(d.platform, loc.path, link.sub) : resolved(canonicalCwd ? localize(canonicalCwd, forms) : null);
    const memTarget = memKey && d.memory?.[memKey] ? resolved(localize(d.memory[memKey], forms)) : null;
    out.push({
      deviceId, device: d.name || deviceId, platform: d.platform || null, seenAt: d.seenAt || null,
      cwd,
      repo: repo ? { key: link.repo, name: repo.name, remote: repo.remote, path: loc?.path || null, status: loc ? loc.status : 'fehlt', by: loc?.by || null } : null,
      memory: memTarget,
    });
  }
  return out;
}

export function describePlace(p) {
  const repo = p.repo ? `Repo ${p.repo.name}: ${p.repo.path || '-'} [${p.repo.status}${p.repo.by === 'dashboard' ? ', aus dem Dashboard' : ''}]` : 'kein Repo';
  return `${p.device}: Ordner ${p.cwd || 'unbekannt'}; ${repo}${p.memory ? `; Memory -> ${p.memory}` : ''}`;
}
