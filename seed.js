// Données de démonstration (facultatif) : une école "demo" avec un compte par rôle.
// Usage : DATABASE_URL=... DEMO_PASSWORD=... node seed.js
const bcrypt = require('bcryptjs');
const { q, one, tx, init, pool } = require('./db');
const { ALL, ROLES } = require('./permissions');

const pwd = process.env.DEMO_PASSWORD;
if (!pwd || pwd.length < 8) { console.error('Définissez DEMO_PASSWORD (8 caractères min.).'); process.exit(1); }

(async () => {
  await init();
  if (await one("SELECT 1 FROM schools WHERE slug='demo'")) { console.log('École demo déjà présente.'); return pool.end(); }
  await tx(async t => {
    const school = (await t.one("INSERT INTO schools (name, slug, cycles) VALUES ('École Démo SunuÉcole Pro','demo','prescolaire,primaire,college') RETURNING id")).id;
    const hash = bcrypt.hashSync(pwd, 10);
    const user = async (u, n, r) => (await t.one('INSERT INTO users (school_id, username, password_hash, full_name, role, permissions) VALUES (?,?,?,?,?,?) RETURNING id',
      [school, u, hash, n, r, r === 'direction' ? ALL : ROLES[r].perms])).id;
    await user('directeur', 'Directeur Démo', 'direction');
    await user('secretariat', 'Secrétaire Démo', 'secretariat');
    await user('caisse', 'Caissier Démo', 'caisse');
    await user('comptable', 'Comptable Démo', 'comptable');
    const t1 = await user('prof.maths', 'M. Diop (Maths)', 'enseignant');
    const t2 = await user('prof.francais', 'Mme Ndiaye (Français)', 'enseignant');
    const cl = async (n, c, f) => (await t.one('INSERT INTO classes (school_id, name, cycle, monthly_fee) VALUES (?,?,?,?) RETURNING id', [school, n, c, f])).id;
    const ps = await cl('Petite Section', 'prescolaire', 15000), cm2 = await cl('CM2', 'primaire', 20000), c6 = await cl('6ème', 'college', 25000);
    const sub = async (cid, n, coef, tid) => {
      const id = (await t.one('INSERT INTO subjects (school_id, class_id, name, coef) VALUES (?,?,?,?) RETURNING id', [school, cid, n, coef])).id;
      if (tid) await t.q('INSERT INTO assignments (school_id, teacher_id, subject_id) VALUES (?,?,?)', [school, tid, id]);
    };
    await sub(cm2, 'Mathématiques', 3, t1); await sub(cm2, 'Français', 3, t2);
    await sub(c6, 'Mathématiques', 4, t1); await sub(c6, 'Français', 4, t2); await sub(c6, 'Histoire-Géographie', 2, null);
    const stu = (cid, f, l, m, sx) => t.q('INSERT INTO students (school_id, class_id, matricule, first_name, last_name, sex, guardian_name, guardian_phone) VALUES (?,?,?,?,?,?,?,?)',
      [school, cid, m, f, l, sx, 'Parent de ' + f, '77 000 00 00']);
    await stu(c6, 'Awa', 'Fall', '2026-0001', 'F'); await stu(c6, 'Moussa', 'Sarr', '2026-0002', 'M'); await stu(c6, 'Fatou', 'Ba', '2026-0003', 'F');
    await stu(cm2, 'Ibrahima', 'Gueye', '2026-0010', 'M'); await stu(cm2, 'Khady', 'Diouf', '2026-0011', 'F'); await stu(ps, 'Aminata', 'Thiam', '2026-0020', 'F');
    await t.q('UPDATE schools SET student_seq = 20 WHERE id = ?', [school]);
  });
  console.log('Démo prête. Code école : demo — comptes : directeur, secretariat, caisse, comptable, prof.maths, prof.francais');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
