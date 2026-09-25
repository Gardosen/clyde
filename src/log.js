// Minimales Logging. CLYDE_QUIET=1 schaltet alles außer Fehlern ab (Tests).
const quiet = process.env.CLYDE_QUIET === '1';
let verbose = false;

export const log = {
  setVerbose(v) { verbose = !!v; },
  info(...a) { if (!quiet) console.log(...a); },
  debug(...a) { if (!quiet && verbose) console.log('   ', ...a); },
  warn(...a) { if (!quiet) console.warn('WARNUNG:', ...a); },
  error(...a) { console.error('FEHLER:', ...a); },
};

export function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let x = Number(n) || 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)} ${units[i]}`;
}
