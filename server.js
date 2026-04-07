'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zloto-meal-planner-secret-2026';
// Support Railway persistent volumes: store DB at /data if that mount exists
const DB_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DB_DIR, 'meal_planner.db');

// ─── Database setup ───────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    email      TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id    INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    grade        TEXT DEFAULT '',
    header_class TEXT DEFAULT 'olive',
    dietary_notes TEXT DEFAULT '',
    sort_order   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS preferences (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    category  TEXT NOT NULL,
    value     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meal_plans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    week_of    TEXT NOT NULL,
    plan_json  TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(family_id, week_of)
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    recipe_id TEXT NOT NULL,
    stars     INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
    notes     TEXT DEFAULT '',
    rated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(family_id, recipe_id)
  );

  CREATE TABLE IF NOT EXISTS custom_recipes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id         INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    emoji             TEXT DEFAULT '🍽️',
    serves            TEXT DEFAULT '4',
    time              TEXT DEFAULT '30 min',
    leftover_note     TEXT DEFAULT '',
    tags_json         TEXT DEFAULT '[]',
    ingredients_json  TEXT DEFAULT '[]',
    steps_json        TEXT DEFAULT '[]',
    source_url        TEXT DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Migrations (safe to run on every start) ──────────────────────────────────
try { db.exec("ALTER TABLE custom_recipes ADD COLUMN source_url TEXT DEFAULT ''"); } catch(e) { /* column already exists */ }

// ─── Zloto seed data ─────────────────────────────────────────────────────────
const ZLOTO_SEED = [
  {
    name: 'Blair', grade: '6th grade · Vegetarian', header_class: 'olive',
    dietary_notes: 'Vegetarian',
    prefs: {
      meals:    ['Caprese pasta salad','Black bean rice bowl','Lentil soup','Garden salad','Cheese quesadilla','Chickpea wrap','Mac & cheese','Falafel + pita'],
      proteins: ['Chickpeas','Black beans','Lentils','Eggs','Falafel','Almonds','Cashews'],
      veggies:  ['Cucumber','Broccoli','Snap peas','Edamame','Cherry tomatoes','Baby carrots','Spinach','Celery'],
      fruits:   ['Apples','Grapes','Strawberries','Blueberries','Raspberries','Clementines','Pears','Watermelon'],
      avoid:    ['Peppers','Onions','Meat'],
    }
  },
  {
    name: 'Blythe', grade: '4th grade · Eats everything', header_class: 'peach',
    dietary_notes: '',
    prefs: {
      meals:    ['Tomato soup + grilled cheese','Pasta with meatballs','Rice & beans','Turkey sandwich','Chicken noodle soup','Mac & cheese','Ham wrap','Beef tacos'],
      proteins: ['Turkey','Ham','Chicken','Ground beef','Meatballs'],
      veggies:  ['Baby carrots','Sugar snap peas','Broccoli','Celery','Cherry tomatoes','Cucumber','Corn'],
      fruits:   ['Apples','Grapes','Strawberries','Watermelon','Blueberries','Clementines','Pears','Peaches'],
      avoid:    ['Nuts (school rule)'],
    }
  },
  {
    name: 'Blake', grade: '2nd grade · Active & picky', header_class: 'blue',
    dietary_notes: '',
    prefs: {
      meals:    ['Chicken + rice burrito','Rice & black beans','Bean + cheese burrito','Rice & chicken','Burrito bowl','Bean quesadilla','Chicken taco'],
      proteins: ['Chicken','Black beans','Pinto beans','Refried beans'],
      veggies:  ['Baby carrots','Corn','Cucumber','Cherry tomatoes','Snap peas'],
      fruits:   ['Apples','Grapes','Clementines','Strawberries','Watermelon','Blueberries','Pears','Raspberries'],
      avoid:    ['Nuts (school rule)','Spicy food'],
    }
  },
];

function seedZlotoFamily(familyId) {
  ZLOTO_SEED.forEach((kid, i) => {
    const member = db.prepare(
      'INSERT INTO members (family_id, name, grade, header_class, dietary_notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(familyId, kid.name, kid.grade, kid.header_class, kid.dietary_notes, i);
    const memberId = member.lastInsertRowid;
    Object.entries(kid.prefs).forEach(([category, values]) => {
      values.forEach(value => {
        db.prepare('INSERT INTO preferences (member_id, category, value) VALUES (?, ?, ?)').run(memberId, category, value);
      });
    });
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.familyId = payload.familyId;
    req.username = payload.username;
    req.email = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ error: 'username, password, and email are required' });
  }
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.prepare('SELECT id FROM families WHERE username = ?').get(username.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare('INSERT INTO families (username, password, email) VALUES (?, ?, ?)').run(username.toLowerCase(), hash, email);
  const familyId = result.lastInsertRowid;

  // Seed Zloto family data for the "zloto" account
  if (username.toLowerCase() === 'zloto') {
    seedZlotoFamily(familyId);
  }

  const token = jwt.sign({ familyId, username: username.toLowerCase(), email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: username.toLowerCase(), email });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  const family = db.prepare('SELECT * FROM families WHERE username = ?').get(username.toLowerCase());
  if (!family) return res.status(401).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, family.password);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ familyId: family.id, username: family.username, email: family.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: family.username, email: family.email });
});

// ─── Profile routes ───────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, (req, res) => {
  const members = db.prepare('SELECT * FROM members WHERE family_id = ? ORDER BY sort_order, id').all(req.familyId);
  const prefs = db.prepare('SELECT * FROM preferences WHERE member_id IN (SELECT id FROM members WHERE family_id = ?)').all(req.familyId);
  const family = db.prepare('SELECT username, email FROM families WHERE id = ?').get(req.familyId);

  // Attach prefs to each member
  const membersWithPrefs = members.map(m => ({
    ...m,
    preferences: prefs.filter(p => p.member_id === m.id),
  }));

  res.json({ family, members: membersWithPrefs });
});

app.post('/api/profile/members', requireAuth, (req, res) => {
  const { name, grade, header_class, dietary_notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM members WHERE family_id = ?').get(req.familyId);
  const sortOrder = (maxOrder.m || 0) + 1;
  const result = db.prepare(
    'INSERT INTO members (family_id, name, grade, header_class, dietary_notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.familyId, name, grade || '', header_class || 'olive', dietary_notes || '', sortOrder);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...member, preferences: [] });
});

app.delete('/api/profile/members/:id', requireAuth, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(req.params.id, req.familyId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/profile/preferences', requireAuth, (req, res) => {
  const { member_id, category, value } = req.body;
  if (!member_id || !category || !value) return res.status(400).json({ error: 'member_id, category, and value are required' });
  // Verify member belongs to this family
  const member = db.prepare('SELECT id FROM members WHERE id = ? AND family_id = ?').get(member_id, req.familyId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  // Avoid duplicates
  const existing = db.prepare('SELECT id FROM preferences WHERE member_id = ? AND category = ? AND LOWER(value) = LOWER(?)').get(member_id, category, value);
  if (existing) return res.status(409).json({ error: 'Preference already exists' });
  const result = db.prepare('INSERT INTO preferences (member_id, category, value) VALUES (?, ?, ?)').run(member_id, category, value);
  res.json({ id: result.lastInsertRowid, member_id, category, value });
});

app.delete('/api/profile/preferences/:id', requireAuth, (req, res) => {
  // Verify pref belongs to this family (via member)
  const pref = db.prepare(
    'SELECT p.id FROM preferences p JOIN members m ON p.member_id = m.id WHERE p.id = ? AND m.family_id = ?'
  ).get(req.params.id, req.familyId);
  if (!pref) return res.status(404).json({ error: 'Preference not found' });
  db.prepare('DELETE FROM preferences WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Meal plan routes ─────────────────────────────────────────────────────────
app.get('/api/meal-plan', requireAuth, (req, res) => {
  const { week_of } = req.query;
  if (!week_of) return res.status(400).json({ error: 'week_of query param required' });
  const plan = db.prepare('SELECT * FROM meal_plans WHERE family_id = ? AND week_of = ?').get(req.familyId, week_of);
  if (!plan) return res.json({ plan: null });
  res.json({ plan: JSON.parse(plan.plan_json), week_of: plan.week_of });
});

app.put('/api/meal-plan', requireAuth, (req, res) => {
  const { week_of, plan } = req.body;
  if (!week_of || !plan) return res.status(400).json({ error: 'week_of and plan are required' });
  db.prepare(`
    INSERT INTO meal_plans (family_id, week_of, plan_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(family_id, week_of) DO UPDATE SET plan_json = excluded.plan_json, updated_at = excluded.updated_at
  `).run(req.familyId, week_of, JSON.stringify(plan));
  res.json({ ok: true });
});

// ─── Rating routes ────────────────────────────────────────────────────────────
app.get('/api/ratings', requireAuth, (req, res) => {
  const ratings = db.prepare('SELECT * FROM ratings WHERE family_id = ?').all(req.familyId);
  res.json({ ratings });
});

app.post('/api/ratings', requireAuth, (req, res) => {
  const { recipe_id, stars, notes } = req.body;
  if (!recipe_id || !stars) return res.status(400).json({ error: 'recipe_id and stars are required' });
  if (stars < 1 || stars > 5) return res.status(400).json({ error: 'stars must be 1–5' });
  db.prepare(`
    INSERT INTO ratings (family_id, recipe_id, stars, notes, rated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(family_id, recipe_id) DO UPDATE SET stars = excluded.stars, notes = excluded.notes, rated_at = excluded.rated_at
  `).run(req.familyId, recipe_id, stars, notes || '');
  res.json({ ok: true });
});

// ─── Custom recipe routes ─────────────────────────────────────────────────────
app.get('/api/custom-recipes', requireAuth, (req, res) => {
  const recipes = db.prepare('SELECT * FROM custom_recipes WHERE family_id = ? ORDER BY created_at DESC').all(req.familyId);
  res.json({ recipes: recipes.map(parseRecipe) });
});

app.post('/api/custom-recipes', requireAuth, (req, res) => {
  const { name, emoji, serves, time, leftover_note, source_url, tags, ingredients, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = db.prepare(`
    INSERT INTO custom_recipes (family_id, name, emoji, serves, time, leftover_note, source_url, tags_json, ingredients_json, steps_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.familyId, name, emoji || '🍽️', serves || '4', time || '30 min',
         leftover_note || '', source_url || '', JSON.stringify(tags || []),
         JSON.stringify(ingredients || []), JSON.stringify(steps || []));
  const recipe = db.prepare('SELECT * FROM custom_recipes WHERE id = ?').get(result.lastInsertRowid);
  res.json(parseRecipe(recipe));
});

app.put('/api/custom-recipes/:id', requireAuth, (req, res) => {
  const recipe = db.prepare('SELECT * FROM custom_recipes WHERE id = ? AND family_id = ?').get(req.params.id, req.familyId);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const { name, emoji, serves, time, leftover_note, source_url, tags, ingredients, steps } = req.body;
  db.prepare(`
    UPDATE custom_recipes SET name=?, emoji=?, serves=?, time=?, leftover_note=?, source_url=?, tags_json=?, ingredients_json=?, steps_json=?
    WHERE id=?
  `).run(name || recipe.name, emoji || recipe.emoji, serves || recipe.serves,
         time || recipe.time, leftover_note ?? recipe.leftover_note,
         source_url ?? recipe.source_url ?? '',
         JSON.stringify(tags || []), JSON.stringify(ingredients || []),
         JSON.stringify(steps || []), req.params.id);
  const updated = db.prepare('SELECT * FROM custom_recipes WHERE id = ?').get(req.params.id);
  res.json(parseRecipe(updated));
});

app.delete('/api/custom-recipes/:id', requireAuth, (req, res) => {
  const recipe = db.prepare('SELECT * FROM custom_recipes WHERE id = ? AND family_id = ?').get(req.params.id, req.familyId);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  db.prepare('DELETE FROM custom_recipes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function parseRecipe(r) {
  return { ...r, tags: JSON.parse(r.tags_json || '[]'), ingredients: JSON.parse(r.ingredients_json || '[]'), steps: JSON.parse(r.steps_json || '[]') };
}

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Zloto Family Meal Planner running at http://localhost:${PORT}`);
});
