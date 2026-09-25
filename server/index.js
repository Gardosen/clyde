import { createServer } from './server.js';

const port = Number(process.env.CLYDE_LISTEN_PORT || 8484);
const dataDir = process.env.CLYDE_DATA_DIR || './data';
const adminUser = (process.env.CLYDE_ADMIN_USER || 'admin').trim().toLowerCase();
const adminPassword = process.env.CLYDE_ADMIN_PASSWORD || undefined;
let token = process.env.CLYDE_TOKEN || undefined;

if (token === 'bitte-ersetzen') token = undefined;
if (adminPassword && adminPassword.length < 10) {
  console.error('CLYDE_ADMIN_PASSWORD braucht mindestens 10 Zeichen');
  process.exit(1);
}

createServer({ dataDir, token, adminUser, adminPassword }).listen(port, '0.0.0.0', () => {
  console.log(`clyde-server lauscht auf Port ${port}, Daten unter ${dataDir}`);
  if (token) console.log(`Alt-Token aus CLYDE_TOKEN gilt als Client-Token von "${adminUser}"`);
});
