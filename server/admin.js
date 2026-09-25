// Benutzerverwaltung auf der Kommandozeile, fuer den Notfall (Passwort vergessen)
// oder zum Einrichten ohne Dashboard. Im Container:
//   docker compose exec clyde node server/admin.js list
//   docker compose exec clyde node server/admin.js add NAME [--admin]
//   docker compose exec clyde node server/admin.js passwd NAME
//   docker compose exec clyde node server/admin.js token NAME [BEZEICHNUNG]
// Neue Passwoerter werden erzeugt und ausgegeben, ausser CLYDE_NEW_PASSWORD ist gesetzt.
import crypto from 'node:crypto';
import { Users } from './users.js';

const dataDir = process.env.CLYDE_DATA_DIR || './data';
const users = new Users(dataDir);
const [cmd, name, ...rest] = process.argv.slice(2);
const newPassword = () => process.env.CLYDE_NEW_PASSWORD || crypto.randomBytes(15).toString('base64url');

try {
  if (cmd === 'list') {
    for (const u of users.list()) console.log(`${u.name}${u.admin ? ' (Admin)' : ''}  angelegt ${u.createdAt}  ${u.tokens} Tokens`);
  } else if (cmd === 'add' && name) {
    const pw = newPassword();
    await users.create(name, pw, { admin: rest.includes('--admin') });
    console.log(`Benutzer ${name} angelegt. Passwort: ${pw}`);
  } else if (cmd === 'passwd' && name) {
    const pw = newPassword();
    await users.setPassword(name, pw);
    console.log(`Neues Passwort fuer ${name}: ${pw}  (alle Browser-Sitzungen abgemeldet)`);
  } else if (cmd === 'admin' && name) {
    users.setAdmin(name, rest[0] !== 'off');
    console.log(`${name}: Admin ${rest[0] !== 'off' ? 'an' : 'aus'}`);
  } else if (cmd === 'token' && name) {
    const t = users.addToken(name, rest.join(' ') || 'PC');
    console.log(`Client-Token fuer ${name} (${t.label}): ${t.token}`);
  } else if (cmd === 'del' && name) {
    console.log(users.remove(name) ? `Benutzer ${name} entfernt (Daten unter u/${name} bleiben liegen)` : `Benutzer ${name} nicht gefunden`);
  } else {
    console.log('Aufruf: node server/admin.js list | add NAME [--admin] | passwd NAME | admin NAME [off] | token NAME [BEZEICHNUNG] | del NAME');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`FEHLER: ${e.message}`);
  process.exit(1);
}
