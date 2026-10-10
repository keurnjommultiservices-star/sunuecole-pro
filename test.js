// Tests de bout en bout. Usage : DATABASE_URL=postgres://... node test.js
// ATTENTION : vide complètement la base pointée par DATABASE_URL (réservé à une base de test locale).
const assert = require('assert');
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Refus : DATABASE_URL doit pointer vers localhost pour les tests.'); process.exit(1); }
process.env.SUPERADMIN_USERNAME = 'kms';
process.env.SUPERADMIN_PASSWORD = 'SuperSecret2026';
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '0';

const { pool } = require('./db');
let base, server, passed = 0;

async function call(method, path, token, body) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const ok = (name, cond) => { assert.ok(cond, 'ÉCHEC : ' + name); passed++; console.log('  ✓', name); };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, `ÉCHEC : ${name} (obtenu ${JSON.stringify(a)}, attendu ${JSON.stringify(b)})`); passed++; console.log('  ✓', name); };

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { start } = require('./server');
  server = await start();
  base = 'http://localhost:' + server.address().port;
  const login = async (code, u, p = 'Motdepasse1') => (await call('POST', '/login', null, { school_code: code, username: u, password: p }));

  console.log('Inscription des écoles');
  let r = await call('POST', '/register', null, { school_name: 'Collège Alpha', director_name: 'Directeur Alpha', username: 'directeur', password: 'Motdepasse1', cycles: ['college'] });
  eq('école A créée', [r.status, r.body.school_code], [201, 'college-alpha']);
  const dirA = r.body.token;
  r = await call('POST', '/register', null, { school_name: 'Collège Alpha', director_name: 'Directeur X', username: 'directeur', password: 'Motdepasse1' });
  eq('code déjà pris -> 409', r.status, 409);
  r = await call('POST', '/register', null, { school_name: 'Petite École', director_name: 'Directrice Bêta', username: 'directeur', password: 'court' });
  eq('mot de passe faible -> 400', r.status, 400);
  r = await call('POST', '/register', null, { school_name: 'École Bêta', code: 'beta', director_name: 'Directrice Bêta', username: 'directeur', password: 'Motdepasse1' });
  eq('école B créée (même identifiant "directeur" que A)', r.status, 201);
  const dirB = r.body.token;
  r = await call('POST', '/register', null, { school_name: 'Admin', code: 'admin', director_name: 'Pirate', username: 'pirate', password: 'Motdepasse1' });
  eq('code réservé refusé', r.status, 400);

  console.log('Connexion');
  eq('connexion directeur A', (await login('college-alpha', 'directeur')).status, 200);
  eq('mauvais code école -> 401', (await login('beta-faux', 'directeur')).status, 401);
  eq('mauvais mot de passe -> 401', (await login('college-alpha', 'directeur', 'Mauvais123')).status, 401);
  const kms = (await call('POST', '/login', null, { school_code: '', username: 'kms', password: 'SuperSecret2026' }));
  eq('superadmin connecté (code vide)', kms.status, 200);

  console.log('Directeur A configure son école et ses utilisateurs');
  const cls = (await call('POST', '/classes', dirA, { name: '6ème A', cycle: 'college', monthly_fee: 25000 })).body.id;
  const st1 = (await call('POST', '/students', dirA, { first_name: 'Awa', last_name: 'Fall', class_id: cls })).body;
  const st2 = (await call('POST', '/students', dirA, { first_name: 'Moussa', last_name: 'Sarr', class_id: cls })).body;
  eq('matricules séquentiels', [st1.matricule.slice(-4), st2.matricule.slice(-4)], ['0001', '0002']);
  const mk = async (u, role, permissions) => (await call('POST', '/users', dirA, { full_name: 'Personnel ' + u, username: u, password: 'Motdepasse1', role, permissions })).status;
  eq('création caissier (modèle)', await mk('caisse', 'caisse'), 201);
  eq('création prof Maths', await mk('prof.maths', 'enseignant'), 201);
  eq('création prof Français', await mk('prof.fr', 'enseignant'), 201);
  eq('création utilisateur sur mesure', await mk('stagiaire', 'autre', ['eleves.voir', 'permission.inventee']), 201);
  eq('identifiant en double -> 409', await mk('caisse', 'caisse'), 409);
  eq('même identifiant "caisse" possible dans l\'école B', (await call('POST', '/users', dirB, { full_name: 'Caisse B', username: 'caisse', password: 'Motdepasse1', role: 'caisse' })).status, 201);
  const users = (await call('GET', '/users', dirA)).body;
  const stag = users.find(u => u.username === 'stagiaire');
  eq('permission inventée ignorée', stag.permissions, ['eleves.voir']);

  const tok = async (code, u) => (await login(code, u)).body.token;
  const caisse = await tok('college-alpha', 'caisse'), pMaths = await tok('college-alpha', 'prof.maths'), pFr = await tok('college-alpha', 'prof.fr'), stagT = await tok('college-alpha', 'stagiaire');
  const teacherId = n => users.find(u => u.username === n).id;
  const maths = (await call('POST', '/subjects', dirA, { class_id: cls, name: 'Maths', coef: 3, teacher_id: teacherId('prof.maths') })).body.id;
  const fr = (await call('POST', '/subjects', dirA, { class_id: cls, name: 'Français', coef: 1, teacher_id: teacherId('prof.fr') })).body.id;

  console.log('Habilitations');
  eq('caissier encaisse', (await call('POST', '/payments', caisse, { student_id: st1.id, amount: 25000, label: 'Mensualité', method: 'wave' })).status, 201);
  eq('caissier ne crée pas de classe -> 403', (await call('POST', '/classes', caisse, { name: 'X', cycle: 'college' })).status, 403);
  eq('caissier ne gère pas les utilisateurs -> 403', (await call('GET', '/users', caisse)).status, 403);
  eq('caissier ne saisit pas de notes -> 403', (await call('GET', '/my-subjects', caisse)).status, 403);
  eq('stagiaire voit les élèves', (await call('GET', '/students', stagT)).status, 200);
  eq('stagiaire ne voit pas la caisse -> 403', (await call('GET', '/payments', stagT)).status, 403);
  eq('stagiaire ne peut pas inscrire -> 403', (await call('POST', '/students', stagT, { first_name: 'A', last_name: 'B' })).status, 403);
  const caisseId = teacherId('caisse');
  eq('directeur retire "encaisser"', (await call('PATCH', '/users/' + caisseId, dirA, { permissions: ['caisse.voir', 'dashboard.voir'] })).status, 200);
  eq('effet immédiat sur le jeton existant -> 403', (await call('POST', '/payments', caisse, { student_id: st1.id, amount: 1000, label: 'x' })).status, 403);
  eq('lecture de la caisse toujours permise', (await call('GET', '/payments', caisse)).status, 200);

  console.log('Notes');
  eq('prof Maths voit ses matières seulement', (await call('GET', '/my-subjects', pMaths)).body.map(s => s.id), [maths]);
  eq('prof Maths saisit en Maths', (await call('POST', '/grades', pMaths, { subject_id: maths, term: 1, grades: [{ student_id: st1.id, value: 16 }, { student_id: st2.id, value: 10 }] })).status, 200);
  eq('prof Maths refusé en Français -> 403', (await call('POST', '/grades', pMaths, { subject_id: fr, term: 1, grades: [{ student_id: st1.id, value: 20 }] })).status, 403);
  eq('note > 20 refusée -> 400', (await call('POST', '/grades', pMaths, { subject_id: maths, term: 1, grades: [{ student_id: st1.id, value: 25 }] })).status, 400);
  eq('prof Français saisit en Français', (await call('POST', '/grades', pFr, { subject_id: fr, term: 1, grades: [{ student_id: st1.id, value: 12 }] })).status, 200);
  await call('PATCH', '/users/' + teacherId('prof.fr'), dirA, { permissions: ['notes.saisir', 'notes.toutes'] });
  eq('"notes.toutes" donne accès à toutes les matières', (await call('POST', '/grades', pFr, { subject_id: maths, term: 1, grades: [{ student_id: st2.id, value: 11 }] })).status, 200);
  await call('PATCH', '/users/' + teacherId('prof.fr'), dirA, { permissions: ['bulletins.voir'] });
  eq('sans habilitation notes -> 403', (await call('GET', '/my-subjects', pFr)).status, 403);
  const b = (await call('GET', `/bulletin/${st1.id}?term=1`, pFr)).body;
  eq('bulletin : moyenne pondérée (16×3+12×1)/4 = 15, rang 1/2', [b.moyenne, b.rang, b.effectif, b.mention], [15, 1, 2, 'Bien']);

  console.log('Isolation entre écoles');
  eq('école B ne voit aucun élève de A', (await call('GET', '/students', dirB)).body, []);
  eq('école B ne voit pas les classes de A', (await call('GET', '/classes', dirB)).body, []);
  eq('école B ne peut pas lire un bulletin de A -> 404', (await call('GET', `/bulletin/${st1.id}?term=1`, dirB)).status, 404);
  eq('école B ne peut pas modifier un utilisateur de A -> 404', (await call('PATCH', '/users/' + caisseId, dirB, { active: false })).status, 404);
  eq('école B ne peut pas encaisser pour un élève de A -> 400', (await call('POST', '/payments', dirB, { student_id: st1.id, amount: 5000, label: 'x' })).status, 400);
  eq('école B ne peut pas inscrire dans une classe de A -> 400', (await call('POST', '/students', dirB, { first_name: 'A', last_name: 'B', class_id: cls })).status, 400);
  eq('un directeur n\'accède pas à la liste des écoles -> 403', (await call('GET', '/schools', dirA)).status, 403);
  eq('sans jeton -> 401', (await call('GET', '/students')).status, 401);

  console.log('Garde-fous');
  const meA = (await call('GET', '/me', dirA)).body.user;
  eq('le dernier Directeur ne peut pas être rétrogradé', (await call('PATCH', '/users/' + meA.id, dirA, { role: 'caisse' })).status, 400);
  eq('on ne peut pas se désactiver soi-même', (await call('PATCH', '/users/' + meA.id, dirA, { active: false })).status, 400);
  await call('PATCH', '/users/' + teacherId('stagiaire'), dirA, { password: 'NouveauMdp12' });
  eq('mot de passe réinitialisé par le directeur', (await login('college-alpha', 'stagiaire', 'NouveauMdp12')).status, 200);
  await call('PATCH', '/users/' + teacherId('stagiaire'), dirA, { active: false });
  eq('compte désactivé : connexion refusée', (await login('college-alpha', 'stagiaire', 'NouveauMdp12')).status, 401);
  eq('compte désactivé : jeton existant refusé', (await call('GET', '/students', stagT)).status, 401);

  console.log('Superadmin KMS');
  const kt = kms.body.token;
  const schools = (await call('GET', '/schools', kt)).body;
  eq('KMS voit les 2 écoles inscrites', schools.map(s => s.slug).sort(), ['beta', 'college-alpha']);
  const idA = schools.find(s => s.slug === 'college-alpha').id;
  await call('PATCH', '/schools/' + idA, kt, { active: false });
  eq('école suspendue : connexion refusée -> 403', (await login('college-alpha', 'directeur')).status, 403);
  eq('école suspendue : jeton existant refusé -> 403', (await call('GET', '/students', dirA)).status, 403);
  eq('école B non affectée', (await call('GET', '/students', dirB)).status, 200);
  await call('PATCH', '/schools/' + idA, kt, { active: true });
  eq('réactivation', (await call('GET', '/students', dirA)).status, 200);
  eq('reset du mot de passe du directeur par KMS', (await call('POST', `/schools/${idA}/reset-director`, kt, { password: 'ResetParKms99' })).status, 200);
  eq('connexion avec le nouveau mot de passe', (await login('college-alpha', 'directeur', 'ResetParKms99')).status, 200);

  console.log(`\n${passed} vérifications réussies.`);
})().then(() => { server.close(); pool.end(); }).catch(e => { console.error('\n' + (e.message || e)); if (server) server.close(); pool.end(); process.exit(1); });
