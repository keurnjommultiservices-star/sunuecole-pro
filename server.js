const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { q, one, tx, init } = require('./db');
const { CATALOG, ALL, ROLES, clean } = require('./permissions');

const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (PROD ? null : 'dev-secret-a-changer');
if (!JWT_SECRET) { console.error('JWT_SECRET obligatoire en production.'); process.exit(1); }
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1); // Render est derrière un proxy
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilitaires ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.code === '23505') return res.status(409).json({ error: 'Cet enregistrement existe déjà.' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

// Limiteur simple en mémoire (par IP) — suffisant pour une instance unique
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + req.ip, now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    arr.push(now); hits.set(key, arr);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const slugify = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const RESERVED = ['admin', 'api', 'www', 'app', 'sunuecole', 'support', 'demo-admin'];
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
const signToken = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '12h' });
const checkPassword = p => { if (String(p || '').length < 8) bad('Le mot de passe doit contenir au moins 8 caractères.'); };
const userPayload = u => ({ id: u.id, name: u.full_name, role: u.role, school_id: u.school_id, perms: u.perms });

// ---------- Authentification ----------
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    let id;
    try { id = jwt.verify(token, JWT_SECRET).id; } catch { return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' }); }
    // Les droits sont relus en base à chaque requête : un changement d'habilitation est immédiat.
    const u = await one(`SELECT u.*, s.active AS school_active, s.name AS school_name, s.slug AS school_code FROM users u LEFT JOIN schools s ON s.id = u.school_id WHERE u.id = ?`, [id]);
    if (!u || !u.active) return res.status(401).json({ error: 'Compte désactivé.' });
    if (u.school_id && !u.school_active) return res.status(403).json({ error: "L'abonnement de cet établissement est suspendu." });
    u.perms = u.role === 'direction' ? ALL : (u.role === 'superadmin' ? [] : u.permissions);
    u.school_name = u.school_name || null;
    req.user = u;
    next();
  } catch (e) { next(e); }
}
const sid = req => req.user.school_id;
const can = (req, p) => req.user.perms.includes(p);
const need = (...perms) => (req, res, next) =>
  perms.some(p => can(req, p)) ? next() : res.status(403).json({ error: "Vous n'avez pas l'habilitation nécessaire." });
const onlyRole = role => (req, res, next) => req.user.role === role ? next() : res.status(403).json({ error: 'Accès réservé.' });

// Inscription libre d'une école : crée l'école ET son compte Directeur
app.post('/api/register', limit('register', 8, 3600e3), h(async (req, res) => {
  const b = req.body || {};
  const name = String(b.school_name || '').trim();
  const director = String(b.director_name || '').trim();
  const username = String(b.username || '').trim().toLowerCase();
  const code = slugify(b.code || name);
  if (name.length < 3) bad("Indiquez le nom de l'établissement.");
  if (director.length < 3) bad('Indiquez le nom du Directeur.');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) bad("Identifiant : 3 à 30 caractères (lettres, chiffres, point, tiret).");
  if (code.length < 3 || RESERVED.includes(code)) bad("Code d'école invalide ou réservé (3 caractères minimum).");
  if (b.email && !/^\S+@\S+\.\S+$/.test(b.email)) bad('Adresse e-mail invalide.');
  checkPassword(b.password);
  const cycles = ['prescolaire', 'primaire', 'college', 'lycee'].filter(c => (b.cycles || []).includes(c));
  if (await one('SELECT 1 FROM schools WHERE slug = ?', [code])) bad("Ce code d'école est déjà utilisé, choisissez-en un autre.", 409);
  const user = await tx(async t => {
    const s = await t.one('INSERT INTO schools (name, slug, cycles) VALUES (?,?,?) RETURNING id', [name, code, (cycles.length ? cycles : ['primaire']).join(',')]);
    return t.one(`INSERT INTO users (school_id, username, email, password_hash, full_name, role, permissions) VALUES (?,?,?,?,?,'direction',?) RETURNING id`,
      [s.id, username, b.email || null, bcrypt.hashSync(b.password, 10), director, ALL]);
  });
  res.status(201).json({ token: signToken(user), school_code: code });
}));

app.post('/api/login', limit('login', 15, 15 * 60e3), h(async (req, res) => {
  const { school_code, username, password } = req.body || {};
  const code = slugify(school_code);
  const uname = String(username || '').trim().toLowerCase();
  const u = code && code !== 'admin'
    ? await one(`SELECT u.*, s.active AS school_active FROM users u JOIN schools s ON s.id = u.school_id WHERE s.slug = ? AND u.username = ?`, [code, uname])
    : await one('SELECT u.*, TRUE AS school_active FROM users u WHERE u.school_id IS NULL AND u.username = ?', [uname]);
  const ok = bcrypt.compareSync(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || !u.active) return res.status(401).json({ error: "Code d'école, identifiant ou mot de passe incorrect." });
  if (!u.school_active) return res.status(403).json({ error: "L'abonnement de cet établissement est suspendu." });
  res.json({ token: signToken(u) });
}));

app.get('/api/me', auth, h(async (req, res) => {
  res.json({ user: userPayload(req.user), school: req.user.school_id ? { name: req.user.school_name, code: req.user.school_code } : null, catalog: CATALOG, roles: ROLES });
}));
app.post('/api/me/password', auth, h(async (req, res) => {
  const { current, password } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) bad('Mot de passe actuel incorrect.');
  checkPassword(password);
  await q('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------- Superadmin (KMS) ----------
app.get('/api/schools', auth, onlyRole('superadmin'), h(async (req, res) => {
  res.json(await q(`SELECT s.*, (SELECT COUNT(*) FROM students WHERE school_id=s.id) AS students,
    (SELECT COUNT(*) FROM users WHERE school_id=s.id) AS users,
    (SELECT full_name FROM users WHERE school_id=s.id AND role='direction' ORDER BY id LIMIT 1) AS director,
    (SELECT email FROM users WHERE school_id=s.id AND role='direction' ORDER BY id LIMIT 1) AS director_email
    FROM schools s ORDER BY s.id DESC`));
}));
app.patch('/api/schools/:id', auth, onlyRole('superadmin'), h(async (req, res) => {
  await q('UPDATE schools SET active = ? WHERE id = ?', [!!req.body.active, req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/schools/:id/reset-director', auth, onlyRole('superadmin'), h(async (req, res) => {
  checkPassword(req.body && req.body.password);
  const d = await one("SELECT id FROM users WHERE school_id = ? AND role = 'direction' ORDER BY id LIMIT 1", [req.params.id]);
  if (!d) bad('Directeur introuvable.', 404);
  await q('UPDATE users SET password_hash = ?, active = TRUE WHERE id = ?', [bcrypt.hashSync(req.body.password, 10), d.id]);
  res.json({ ok: true });
}));

// ---------- Utilisateurs & habilitations (Directeur) ----------
const userCols = 'id, username, full_name, email, role, permissions, active';
app.get('/api/users', auth, onlyRole('direction'), h(async (req, res) => {
  const rows = await q(`SELECT ${userCols} FROM users WHERE school_id = ? ORDER BY role <> 'direction', full_name`, [sid(req)]);
  res.json(rows.map(u => ({ ...u, permissions: u.role === 'direction' ? ALL : u.permissions })));
}));
app.post('/api/users', auth, onlyRole('direction'), h(async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  if (!ROLES[b.role]) bad('Rôle invalide.');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) bad('Identifiant : 3 à 30 caractères (lettres, chiffres, point, tiret).');
  if (String(b.full_name || '').trim().length < 3) bad('Nom complet requis.');
  checkPassword(b.password);
  const perms = b.role === 'direction' ? ALL : clean(b.permissions || ROLES[b.role].perms);
  const r = await one(`INSERT INTO users (school_id, username, email, password_hash, full_name, role, permissions) VALUES (?,?,?,?,?,?,?) RETURNING id`,
    [sid(req), username, b.email || null, bcrypt.hashSync(b.password, 10), b.full_name.trim(), b.role, perms]);
  res.status(201).json({ id: r.id });
}));
app.patch('/api/users/:id', auth, onlyRole('direction'), h(async (req, res) => {
  const b = req.body || {};
  const u = await one('SELECT * FROM users WHERE id = ? AND school_id = ?', [req.params.id, sid(req)]);
  if (!u) bad('Utilisateur introuvable.', 404);
  const role = b.role ?? u.role;
  if (!ROLES[role]) bad('Rôle invalide.');
  let perms = u.permissions;
  if (b.permissions !== undefined) perms = clean(b.permissions);
  else if (b.role && b.role !== u.role) perms = ROLES[role].perms;
  if (role === 'direction') perms = ALL;
  const active = b.active === undefined ? u.active : !!b.active;
  // Garde-fou : une école doit toujours garder un Directeur actif
  if (u.role === 'direction' && (role !== 'direction' || !active)) {
    const n = await one("SELECT COUNT(*) AS n FROM users WHERE school_id = ? AND role = 'direction' AND active AND id <> ?", [sid(req), u.id]);
    if (n.n === 0) bad("Impossible : l'école doit conserver au moins un Directeur actif.");
  }
  if (u.id === req.user.id && !active) bad('Vous ne pouvez pas désactiver votre propre compte.');
  if (b.password !== undefined) checkPassword(b.password);
  await q(`UPDATE users SET full_name = ?, email = ?, role = ?, permissions = ?, active = ?, password_hash = ? WHERE id = ?`,
    [String(b.full_name || u.full_name).trim(), b.email === undefined ? u.email : (b.email || null), role, perms, active, b.password ? bcrypt.hashSync(b.password, 10) : u.password_hash, u.id]);
  res.json({ ok: true });
}));

// ---------- Classes & matières ----------
app.get('/api/classes', auth, need('classes.voir', 'eleves.voir', 'classes.gerer'), h(async (req, res) => {
  res.json(await q(`SELECT c.*, (SELECT COUNT(*) FROM students WHERE class_id=c.id AND status='actif') AS effectif
    FROM classes c WHERE school_id=? ORDER BY cycle, name`, [sid(req)]));
}));
app.post('/api/classes', auth, need('classes.gerer'), h(async (req, res) => {
  const { name, cycle, monthly_fee } = req.body || {};
  if (!name || !['prescolaire', 'primaire', 'college', 'lycee'].includes(cycle)) bad('Nom et cycle valides requis.');
  const r = await one('INSERT INTO classes (school_id, name, cycle, monthly_fee) VALUES (?,?,?,?) RETURNING id', [sid(req), name.trim(), cycle, parseInt(monthly_fee) || 0]);
  res.status(201).json({ id: r.id });
}));
app.get('/api/classes/:id/subjects', auth, need('classes.voir', 'classes.gerer'), h(async (req, res) => {
  res.json(await q(`SELECT sb.*, u.full_name AS teacher FROM subjects sb
    LEFT JOIN assignments a ON a.subject_id=sb.id LEFT JOIN users u ON u.id=a.teacher_id
    WHERE sb.school_id=? AND sb.class_id=? ORDER BY sb.name`, [sid(req), req.params.id]));
}));
app.post('/api/subjects', auth, onlyRole('direction'), h(async (req, res) => {
  const { class_id, name, coef, teacher_id } = req.body || {};
  if (!name || !(await one('SELECT 1 FROM classes WHERE id=? AND school_id=?', [class_id, sid(req)]))) bad('Classe et matière requises.');
  const id = await tx(async t => {
    const r = await t.one('INSERT INTO subjects (school_id, class_id, name, coef) VALUES (?,?,?,?) RETURNING id', [sid(req), class_id, name.trim(), parseFloat(coef) || 1]);
    if (teacher_id) {
      if (!(await t.one("SELECT 1 FROM users WHERE id=? AND school_id=? AND active", [teacher_id, sid(req)]))) bad('Enseignant invalide.');
      await t.q('INSERT INTO assignments (school_id, teacher_id, subject_id) VALUES (?,?,?)', [sid(req), teacher_id, r.id]);
    }
    return r.id;
  });
  res.status(201).json({ id });
}));

// ---------- Élèves ----------
app.get('/api/students', auth, need('eleves.voir', 'eleves.gerer', 'bulletins.voir', 'caisse.encaisser', 'caisse.voir'), h(async (req, res) => {
  const { class_id, q: term } = req.query;
  let sql = `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.school_id=?`;
  const p = [sid(req)];
  if (class_id) { sql += ' AND s.class_id=?'; p.push(class_id); }
  if (term) { sql += ' AND (s.last_name ILIKE ? OR s.first_name ILIKE ? OR s.matricule ILIKE ?)'; p.push(`%${term}%`, `%${term}%`, `%${term}%`); }
  res.json(await q(sql + ' ORDER BY s.last_name, s.first_name LIMIT 500', p));
}));
app.post('/api/students', auth, need('eleves.gerer'), h(async (req, res) => {
  const b = req.body || {};
  if (!b.first_name || !b.last_name) bad('Prénom et nom requis.');
  if (b.class_id && !(await one('SELECT 1 FROM classes WHERE id=? AND school_id=?', [b.class_id, sid(req)]))) bad('Classe invalide.');
  const r = await tx(async t => {
    const s = await t.one('UPDATE schools SET student_seq = student_seq + 1 WHERE id = ? RETURNING student_seq', [sid(req)]);
    const matricule = b.matricule || `${new Date().getFullYear()}-${String(s.student_seq).padStart(4, '0')}`;
    const st = await t.one(`INSERT INTO students (school_id, class_id, matricule, first_name, last_name, sex, birth_date, guardian_name, guardian_phone)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`, [sid(req), b.class_id || null, matricule, b.first_name.trim(), b.last_name.trim(), b.sex || null, b.birth_date || null, b.guardian_name || null, b.guardian_phone || null]);
    return { id: st.id, matricule };
  });
  res.status(201).json(r);
}));
app.put('/api/students/:id', auth, need('eleves.gerer'), h(async (req, res) => {
  const b = req.body || {};
  if (b.class_id && !(await one('SELECT 1 FROM classes WHERE id=? AND school_id=?', [b.class_id, sid(req)]))) bad('Classe invalide.');
  const r = await q(`UPDATE students SET class_id=COALESCE(?,class_id), first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name),
    guardian_name=COALESCE(?,guardian_name), guardian_phone=COALESCE(?,guardian_phone), status=COALESCE(?,status) WHERE id=? AND school_id=? RETURNING id`,
    [b.class_id ?? null, b.first_name ?? null, b.last_name ?? null, b.guardian_name ?? null, b.guardian_phone ?? null, b.status ?? null, req.params.id, sid(req)]);
  res.json({ updated: r.length });
}));

// ---------- Notes ----------
async function gradeAccess(req, subjectId) {
  const sub = await one('SELECT * FROM subjects WHERE id=? AND school_id=?', [subjectId, sid(req)]);
  if (!sub) return null;
  if (req.user.role === 'direction' || can(req, 'notes.toutes')) return sub;
  if (can(req, 'notes.saisir') && await one('SELECT 1 FROM assignments WHERE teacher_id=? AND subject_id=?', [req.user.id, subjectId])) return sub;
  return null;
}
app.get('/api/my-subjects', auth, need('notes.saisir', 'notes.toutes'), h(async (req, res) => {
  const base = 'SELECT sb.id, sb.name, sb.coef, c.id AS class_id, c.name AS class_name FROM subjects sb JOIN classes c ON c.id=sb.class_id';
  res.json(req.user.role === 'direction' || can(req, 'notes.toutes')
    ? await q(base + ' WHERE sb.school_id=? ORDER BY c.name, sb.name', [sid(req)])
    : await q(base + ' JOIN assignments a ON a.subject_id=sb.id WHERE a.teacher_id=? ORDER BY c.name, sb.name', [req.user.id]));
}));
app.get('/api/grades', auth, need('notes.saisir', 'notes.toutes'), h(async (req, res) => {
  const { subject_id, term } = req.query;
  const sub = await gradeAccess(req, subject_id);
  if (!sub) bad("Vous n'êtes pas affecté à cette matière.", 403);
  res.json(await q(`SELECT s.id AS student_id, s.matricule, s.last_name, s.first_name, g.value
    FROM students s LEFT JOIN grades g ON g.student_id=s.id AND g.subject_id=? AND g.term=?
    WHERE s.school_id=? AND s.class_id=? AND s.status='actif' ORDER BY s.last_name, s.first_name`, [subject_id, term, sid(req), sub.class_id]));
}));
app.post('/api/grades', auth, need('notes.saisir', 'notes.toutes'), h(async (req, res) => {
  const { subject_id, term, grades } = req.body || {};
  const sub = await gradeAccess(req, subject_id);
  if (!sub) bad("Vous n'êtes pas affecté à cette matière.", 403);
  if (![1, 2, 3].includes(Number(term)) || !Array.isArray(grades)) bad('Trimestre et notes requis.');
  const empty = v => v === '' || v === null || v === undefined;
  if (grades.some(g => !empty(g.value) && !(Number(g.value) >= 0 && Number(g.value) <= 20))) bad('Chaque note doit être comprise entre 0 et 20.');
  const ids = (await q("SELECT id FROM students WHERE school_id=? AND class_id=? AND status='actif'", [sid(req), sub.class_id])).map(r => r.id);
  let saved = 0;
  await tx(async t => {
    for (const g of grades) {
      if (!ids.includes(Number(g.student_id))) continue;
      if (empty(g.value)) { await t.q('DELETE FROM grades WHERE student_id=? AND subject_id=? AND term=?', [g.student_id, subject_id, term]); continue; }
      await t.q(`INSERT INTO grades (school_id, student_id, subject_id, term, value, entered_by) VALUES (?,?,?,?,?,?)
        ON CONFLICT (student_id, subject_id, term) DO UPDATE SET value = EXCLUDED.value, entered_by = EXCLUDED.entered_by, updated_at = now()`,
        [sid(req), g.student_id, subject_id, term, Number(g.value), req.user.id]);
      saved++;
    }
  });
  res.json({ saved });
}));

app.get('/api/bulletin/:studentId', auth, need('bulletins.voir'), h(async (req, res) => {
  const term = Number(req.query.term || 1);
  const st = await one('SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.school_id=?', [req.params.studentId, sid(req)]);
  if (!st) bad('Élève introuvable.', 404);
  const subjects = await q(`SELECT sb.id, sb.name, sb.coef, u.full_name AS teacher FROM subjects sb
    LEFT JOIN assignments a ON a.subject_id=sb.id LEFT JOIN users u ON u.id=a.teacher_id WHERE sb.class_id=? ORDER BY sb.name`, [st.class_id]);
  const grades = await q(`SELECT g.student_id, g.subject_id, g.value FROM grades g JOIN students s ON s.id=g.student_id
    WHERE s.class_id=? AND s.status='actif' AND g.term=?`, [st.class_id, term]);
  const avgOf = studentId => {
    let sum = 0, coefs = 0;
    for (const sb of subjects) { const g = grades.find(x => x.student_id === studentId && x.subject_id === sb.id); if (g) { sum += g.value * sb.coef; coefs += sb.coef; } }
    return coefs ? sum / coefs : null;
  };
  const mates = await q("SELECT id FROM students WHERE class_id=? AND status='actif'", [st.class_id]);
  const ranked = mates.map(m => ({ id: m.id, m: avgOf(m.id) })).filter(x => x.m !== null).sort((a, b) => b.m - a.m);
  const moyenne = avgOf(st.id);
  const rows = subjects.map(sb => ({ name: sb.name, coef: sb.coef, teacher: sb.teacher, value: (grades.find(x => x.student_id === st.id && x.subject_id === sb.id) || {}).value ?? null }));
  const rang = ranked.findIndex(x => x.id === st.id) + 1;
  const mention = moyenne === null ? null : moyenne >= 16 ? 'Très bien' : moyenne >= 14 ? 'Bien' : moyenne >= 12 ? 'Assez bien' : moyenne >= 10 ? 'Passable' : 'Insuffisant';
  res.json({ student: st, term, rows, moyenne: moyenne === null ? null : Math.round(moyenne * 100) / 100, rang: rang || null, effectif: ranked.length, mention });
}));

// ---------- Caisse & comptabilité ----------
app.get('/api/payments', auth, need('caisse.voir', 'caisse.encaisser'), h(async (req, res) => {
  const { student_id, from, to } = req.query;
  let sql = `SELECT p.*, s.first_name, s.last_name, s.matricule, u.full_name AS cashier FROM payments p
    JOIN students s ON s.id=p.student_id LEFT JOIN users u ON u.id=p.created_by WHERE p.school_id=?`;
  const a = [sid(req)];
  if (student_id) { sql += ' AND p.student_id=?'; a.push(student_id); }
  if (from) { sql += ' AND p.created_at::date >= ?::date'; a.push(from); }
  if (to) { sql += ' AND p.created_at::date <= ?::date'; a.push(to); }
  res.json(await q(sql + ' ORDER BY p.id DESC LIMIT 500', a));
}));
app.post('/api/payments', auth, need('caisse.encaisser'), h(async (req, res) => {
  const { student_id, amount, label, method } = req.body || {};
  const amt = parseInt(amount);
  if (!(await one('SELECT 1 FROM students WHERE id=? AND school_id=?', [student_id, sid(req)]))) bad('Élève invalide.');
  if (!(amt > 0) || !label) bad('Montant (> 0) et motif requis.');
  const r = await tx(async t => {
    const s = await t.one('UPDATE schools SET receipt_seq = receipt_seq + 1 WHERE id = ? RETURNING receipt_seq', [sid(req)]);
    const receipt_no = `R${new Date().getFullYear()}-${String(s.receipt_seq).padStart(5, '0')}`;
    const p = await t.one('INSERT INTO payments (school_id, student_id, amount, label, method, receipt_no, created_by) VALUES (?,?,?,?,?,?,?) RETURNING id',
      [sid(req), student_id, amt, label.trim(), ['especes', 'wave', 'orange_money', 'cheque', 'virement'].includes(method) ? method : 'especes', receipt_no, req.user.id]);
    return { id: p.id, receipt_no };
  });
  res.status(201).json(r);
}));
app.get('/api/impayes', auth, need('impayes.voir'), h(async (req, res) => {
  // Estimation : mensualité × mois écoulés depuis octobre (année scolaire), moins les paiements reçus
  const m = new Date().getMonth() + 1;
  const mois = Math.max(1, Math.min(9, m >= 10 ? m - 9 : m + 3));
  res.json({ mois_ecoules: mois, rows: await q(`SELECT * FROM (
      SELECT s.id, s.matricule, s.first_name, s.last_name, s.guardian_phone, c.name AS class_name,
        c.monthly_fee * ? AS attendu, COALESCE((SELECT SUM(amount) FROM payments WHERE student_id=s.id),0) AS paye
      FROM students s JOIN classes c ON c.id=s.class_id WHERE s.school_id=? AND s.status='actif') x
    WHERE attendu > paye ORDER BY (attendu - paye) DESC LIMIT 300`, [mois, sid(req)]) });
}));

// ---------- Tableau de bord ----------
app.get('/api/dashboard', auth, need('dashboard.voir'), h(async (req, res) => {
  const s = sid(req);
  const n = async (sql, p) => (await one(sql, p)).n;
  res.json({
    eleves: await n("SELECT COUNT(*) n FROM students WHERE school_id=? AND status='actif'", [s]),
    classes: await n('SELECT COUNT(*) n FROM classes WHERE school_id=?', [s]),
    personnel: await n('SELECT COUNT(*) n FROM users WHERE school_id=? AND active', [s]),
    encaisse_total: await n('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE school_id=?', [s]),
    encaisse_mois: await n("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE school_id=? AND to_char(created_at,'YYYY-MM')=to_char(now(),'YYYY-MM')", [s]),
    par_cycle: await q(`SELECT c.cycle, COUNT(st.id) AS eleves FROM classes c LEFT JOIN students st ON st.class_id=c.id AND st.status='actif' WHERE c.school_id=? GROUP BY c.cycle`, [s])
  });
}));

app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable.' }));

// Compte superadmin (KMS) créé au démarrage depuis les variables d'environnement
async function bootstrapSuperadmin() {
  const { SUPERADMIN_USERNAME: u, SUPERADMIN_PASSWORD: p } = process.env;
  if (!u || !p) return;
  if (await one("SELECT 1 FROM users WHERE role='superadmin'")) return;
  if (p.length < 10) { console.error('SUPERADMIN_PASSWORD trop court (10 caractères min.) : compte non créé.'); return; }
  await q("INSERT INTO users (school_id, username, password_hash, full_name, role) VALUES (NULL,?,?,?, 'superadmin')", [u.toLowerCase(), bcrypt.hashSync(p, 10), 'Keurnjom Multiservices (KMS)']);
  console.log('Compte superadmin créé.');
}

async function start() {
  await init();
  await bootstrapSuperadmin();
  return app.listen(PORT, () => console.log(`SunuÉcole Pro sur le port ${PORT}`));
}
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });
module.exports = { app, start };
