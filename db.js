const { Pool, types } = require('pg');

// COUNT/SUM -> nombres JS (pg les renvoie en texte par défaut)
types.setTypeParser(20, Number);
types.setTypeParser(1700, Number);

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL manquante (ex: postgres://user:pass@host:5432/base)'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: local || process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10
});

// On écrit le SQL avec des "?" et on convertit en $1, $2...
const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const q = (sql, p = [], c = pool) => c.query(conv(sql), p).then(r => r.rows);
const one = async (sql, p, c) => (await q(sql, p, c))[0];
const tx = async fn => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn({ q: (s, p) => q(s, p, c), one: (s, p) => one(s, p, c) });
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schools (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  cycles TEXT NOT NULL DEFAULT 'primaire',
  address TEXT, phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  receipt_seq INTEGER NOT NULL DEFAULT 0,
  student_seq INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin','direction','secretariat','caisse','comptable','enseignant','autre')),
  permissions TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, username)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_superadmin_username ON users(username) WHERE school_id IS NULL;
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cycle TEXT NOT NULL CHECK (cycle IN ('prescolaire','primaire','college','lycee')),
  monthly_fee INTEGER NOT NULL DEFAULT 0,
  UNIQUE (school_id, name)
);
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  matricule TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  sex TEXT, birth_date DATE,
  guardian_name TEXT, guardian_phone TEXT,
  status TEXT NOT NULL DEFAULT 'actif',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, matricule)
);
CREATE TABLE IF NOT EXISTS subjects (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  coef REAL NOT NULL DEFAULT 1,
  UNIQUE (class_id, name)
);
CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  UNIQUE (teacher_id, subject_id)
);
CREATE TABLE IF NOT EXISTS grades (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 3),
  value REAL NOT NULL CHECK (value BETWEEN 0 AND 20),
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject_id, term)
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  label TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'especes',
  receipt_no TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, receipt_no)
);
CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id, class_id);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_school ON payments(school_id, created_at);
`;

const init = () => pool.query(SCHEMA);

module.exports = { pool, q, one, tx, init };
