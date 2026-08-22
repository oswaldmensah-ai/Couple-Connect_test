require("dotenv").config();

const express = require("express");
const session = require("express-session");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const uploadDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "couple.db"));

// Ensure `seen` column exists for message read receipts
try {
    db.prepare("ALTER TABLE messages ADD COLUMN seen INTEGER NOT NULL DEFAULT 0").run();
} catch (e) {
    // ignore if column already exists
}
db.pragma("journal_mode = WAL");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender INTEGER NOT NULL,
    recipient INTEGER NOT NULL,
    body TEXT NOT NULL,
    unlock_method TEXT NOT NULL CHECK(unlock_method IN ('none','photo','question','either')),
    question TEXT,
    answer_hash TEXT,
    unlocked INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS photo_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    sender INTEGER NOT NULL,
    reader INTEGER NOT NULL,
    filename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    plan_date TEXT,
    plan_time TEXT,
    place TEXT,
    notes TEXT,
    created_by INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY,
    preferred_name TEXT
);
`);

// Role assignments table and default row
db.exec(`
CREATE TABLE IF NOT EXISTS role_assignments (
    id INTEGER PRIMARY KEY CHECK(id=1),
    boyfriend_id INTEGER,
    girlfriend_id INTEGER
);
`);
const ra = db.prepare("SELECT * FROM role_assignments WHERE id=1").get();
if (!ra) {
    db.prepare("INSERT INTO role_assignments(id,boyfriend_id,girlfriend_id) VALUES(1,?,?)").run(1, 2);
}

const users = {
    1: { id: 1, name: process.env.PERSON1_NAME || "Boyfriend", password: process.env.PERSON1_PASSWORD || "password1" },
    2: { id: 2, name: process.env.PERSON2_NAME || "Girlfriend", password: process.env.PERSON2_PASSWORD || "password2" }
};

const hash = (text) => {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(String(text).trim().toLowerCase()).digest("hex");
};

const upload = multer({
    storage: multer.diskStorage({
        destination: uploadDir,
        filename: (_, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
        if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error("Only JPG, PNG or WEBP images are allowed."));
    }
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
    next();
}

function me(req) { return users[req.session.userId]; }

function otherId(id) {
    const row = db.prepare("SELECT boyfriend_id,girlfriend_id FROM role_assignments WHERE id=1").get();
    if (!row) return id === 1 ? 2 : 1;
    if (row.boyfriend_id === id) return row.girlfriend_id;
    if (row.girlfriend_id === id) return row.boyfriend_id;
    return id === 1 ? 2 : 1;
}

function getRoleForUser(id) {
    const row = db.prepare("SELECT boyfriend_id,girlfriend_id FROM role_assignments WHERE id=1").get();
    if (!row) return null;
    if (row.boyfriend_id === id) return 'boyfriend';
    if (row.girlfriend_id === id) return 'girlfriend';
    return null;
}

app.post("/api/login", (req, res) => {
    const id = Number(req.body.userId);
    const user = users[id];
    if (!user || req.body.password !== user.password) return res.status(401).json({ error: "Wrong login details." });
    req.session.userId = id;
    res.json({ id: user.id, name: user.name });
});

app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    const userId = me(req).id;
    const partnerId = otherId(userId);
    const userProfile = db.prepare("SELECT preferred_name FROM user_profiles WHERE user_id=?").get(userId) || {};
    const partnerProfile = db.prepare("SELECT preferred_name FROM user_profiles WHERE user_id=?").get(partnerId) || {};
    res.json({
        user: { id: me(req).id, name: me(req).name, preferred_name: userProfile.preferred_name || null, role: getRoleForUser(userId) },
        partner: { id: partnerId, name: users[partnerId].name, preferred_name: partnerProfile.preferred_name || null, role: getRoleForUser(partnerId) }
    });
});

// Set current user's role (boyfriend or girlfriend)
app.post('/api/roles', auth, (req, res) => {
    const userId = me(req).id;
    const role = String(req.body.role || '').trim();
    if (!['boyfriend', 'girlfriend'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const other = otherId(userId);
    // update role_assignments so that chosen role maps to this user, and the other role maps to the other user
    if (role === 'boyfriend') {
        db.prepare('UPDATE role_assignments SET boyfriend_id=?,girlfriend_id=? WHERE id=1').run(userId, other);
    } else {
        db.prepare('UPDATE role_assignments SET girlfriend_id=?,boyfriend_id=? WHERE id=1').run(userId, other);
    }
    io.emit('refresh');
    res.json({ ok: true });
});

// Update current user's preferred display name
app.post("/api/profile", auth, (req, res) => {
    const userId = me(req).id;
    const preferred = String(req.body.preferred_name || "").trim();
    if (!preferred) return res.status(400).json({ error: "Preferred name cannot be empty." });
    db.prepare(`INSERT INTO user_profiles(user_id, preferred_name) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET preferred_name=excluded.preferred_name`).run(userId, preferred);
    io.emit("refresh");
    res.json({ ok: true });
});

app.get("/api/messages", auth, (req, res) => {
    const id = me(req).id;
    const rows = db.prepare(`
    SELECT m.*,
      (SELECT status FROM photo_requests p WHERE p.message_id=m.id ORDER BY p.id DESC LIMIT 1) AS photo_status
    FROM messages m
    WHERE m.sender=? OR m.recipient=?
    ORDER BY m.id ASC
  `).all(id, id);

    const visible = rows.map(m => {
        const isRecipient = m.recipient === id;
        const canSee = !isRecipient || m.unlocked === 1 || m.unlock_method === "none";
        return {...m, body: canSee ? m.body : null, locked: !canSee };
    });
    res.json(visible);
});

app.post("/api/messages", auth, (req, res) => {
    const sender = me(req).id;
    const recipient = otherId(sender);
    const body = String(req.body.body || "").trim();
    const method = ["none", "photo", "question", "either"].includes(req.body.unlock_method) ? req.body.unlock_method : "none";
    const question = String(req.body.question || "").trim();
    const answer = String(req.body.answer || "").trim();

    if (!body) return res.status(400).json({ error: "Message cannot be empty." });
    if ((method === "question" || method === "either") && (!question || !answer)) {
        return res.status(400).json({ error: "A question and answer are required." });
    }

    const info = db.prepare(`
    INSERT INTO messages(sender, recipient, body, unlock_method, question, answer_hash, unlocked)
    VALUES(?,?,?,?,?,?,?)
  `).run(sender, recipient, body, method, question || null, answer ? hash(answer) : null, method === "none" ? 1 : 0);

    io.emit("refresh");
    res.json({ id: info.lastInsertRowid });
});

app.post("/api/messages/:id/answer", auth, (req, res) => {
    const id = Number(req.params.id);
    const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!msg || msg.recipient !== me(req).id) return res.status(404).json({ error: "Message not found." });
    if (!["question", "either"].includes(msg.unlock_method)) return res.status(400).json({ error: "This message does not use a question." });

    if (hash(req.body.answer || "") !== msg.answer_hash) return res.status(400).json({ error: "Incorrect answer." });

    db.prepare("UPDATE messages SET unlocked=1 WHERE id=?").run(id);
    io.emit("refresh");
    res.json({ ok: true });
});

app.post("/api/messages/:id/photo", auth, upload.single("photo"), (req, res) => {
    const id = Number(req.params.id);
    const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!msg || msg.recipient !== me(req).id) return res.status(404).json({ error: "Message not found." });
    if (!["photo", "either"].includes(msg.unlock_method)) return res.status(400).json({ error: "This message does not use photo proof." });
    if (!req.file) return res.status(400).json({ error: "Choose a photo first." });

    db.prepare(`
    INSERT INTO photo_requests(message_id, sender, reader, filename)
    VALUES(?,?,?,?)
  `).run(id, msg.sender, msg.recipient, req.file.filename);

    io.emit("refresh");
    res.json({ ok: true });
});

// Mark a message as seen by the recipient
app.post("/api/messages/:id/seen", auth, (req, res) => {
    const id = Number(req.params.id);
    const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!msg || msg.recipient !== me(req).id) return res.status(404).json({ error: "Message not found." });

    db.prepare("UPDATE messages SET seen=1 WHERE id=?").run(id);
    io.emit("refresh");
    res.json({ ok: true });
});

app.get("/api/photo-requests", auth, (req, res) => {
    const id = me(req).id;
    const rows = db.prepare(`
    SELECT p.*, m.body AS message_preview, m.unlocked
    FROM photo_requests p JOIN messages m ON m.id=p.message_id
    WHERE p.sender=? OR p.reader=?
    ORDER BY p.id DESC
  `).all(id, id);
    res.json(rows);
});

app.post("/api/photo-requests/:id/approve", auth, (req, res) => {
    const requestId = Number(req.params.id);
    const request = db.prepare("SELECT * FROM photo_requests WHERE id=?").get(requestId);
    if (!request || request.sender !== me(req).id) return res.status(404).json({ error: "Request not found." });

    db.prepare("UPDATE photo_requests SET status='approved' WHERE id=?").run(requestId);
    db.prepare("UPDATE messages SET unlocked=1 WHERE id=?").run(request.message_id);
    io.emit("refresh");
    res.json({ ok: true });
});

app.post("/api/photo-requests/:id/reject", auth, (req, res) => {
    const requestId = Number(req.params.id);
    const request = db.prepare("SELECT * FROM photo_requests WHERE id=?").get(requestId);
    if (!request || request.sender !== me(req).id) return res.status(404).json({ error: "Request not found." });

    db.prepare("UPDATE photo_requests SET status='rejected' WHERE id=?").run(requestId);
    io.emit("refresh");
    res.json({ ok: true });
});

app.get("/api/plans", auth, (req, res) => {
    res.json(db.prepare("SELECT * FROM plans ORDER BY COALESCE(plan_date,'9999-12-31'), COALESCE(plan_time,'23:59'), id").all());
});

app.post("/api/plans", auth, (req, res) => {
    const title = String(req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "Plan title is required." });
    const info = db.prepare(`
    INSERT INTO plans(title, plan_date, plan_time, place, notes, created_by)
    VALUES(?,?,?,?,?,?)
  `).run(title, req.body.plan_date || null, req.body.plan_time || null, String(req.body.place || "").trim(), String(req.body.notes || "").trim(), me(req).id);
    io.emit("refresh");
    res.json({ id: info.lastInsertRowid });
});

app.patch("/api/plans/:id", auth, (req, res) => {
    const id = Number(req.params.id);
    const plan = db.prepare("SELECT * FROM plans WHERE id=?").get(id);
    if (!plan) return res.status(404).json({ error: "Plan not found." });

    db.prepare(`
        UPDATE plans SET title=?, plan_date=?, plan_time=?, place=?, notes=?, completed=?
        WHERE id=?
    `).run(
        String(req.body.title ?? plan.title).trim(),
        req.body.plan_date ?? plan.plan_date,
        req.body.plan_time ?? plan.plan_time,
        String(req.body.place ?? plan.place).trim(),
        String(req.body.notes ?? plan.notes).trim(),
        req.body.completed ? 1 : 0,
        id
    );
    io.emit("refresh");
    res.json({ ok: true });
});

app.delete("/api/plans/:id", auth, (req, res) => {
    db.prepare("DELETE FROM plans WHERE id=?").run(Number(req.params.id));
    io.emit("refresh");
    res.json({ ok: true });
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || (err && err.message && err.message.includes("images"))) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

io.on("connection", socket => {
    socket.on("ping-app", () => socket.emit("pong-app"));
});

server.listen(PORT, '0.0.0.0', () => { console.log(`Couple Connect running on port ${PORT}`); });
