const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const db = createClient({
  url: process.env.TURSO_URL || 'libsql://yrrt-glitchfgy.aws-ap-northeast-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN
});

const JWT_SECRET = process.env.JWT_SECRET || 'chat-super-secret-2024';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar_color TEXT DEFAULT '#5cabf2',
      bio TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER,
      user_id INTEGER,
      username TEXT,
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS private_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER,
      from_username TEXT,
      to_id INTEGER,
      to_username TEXT,
      text TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO rooms (id, name, description) VALUES (1, 'عام', 'الغرفة العامة للجميع');
    INSERT OR IGNORE INTO rooms (id, name, description) VALUES (2, 'ترفيه', 'مرح وضحك');
    INSERT OR IGNORE INTO rooms (id, name, description) VALUES (3, 'تقنية', 'نقاشات تقنية وبرمجة');
    INSERT OR IGNORE INTO rooms (id, name, description) VALUES (4, 'رياضة', 'أخبار رياضية');
  `);
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'بيانات ناقصة' });
  if (username.length < 3) return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' });
  if (password.length < 4) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' });

  try {
    const hashed = await bcrypt.hash(password, 10);
    const colors = ['#5cabf2','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e91e63','#ff5722'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const result = await db.execute({
      sql: 'INSERT INTO users (username, password, avatar_color) VALUES (?, ?, ?)',
      args: [username, hashed, color]
    });
    const token = jwt.sign({ id: Number(result.lastInsertRowid), username }, JWT_SECRET);
    res.json({ token, username, id: Number(result.lastInsertRowid), avatar_color: color });
  } catch {
    res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: 'اسم مستخدم أو كلمة مرور خاطئة' });
    const token = jwt.sign({ id: Number(user.id), username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, id: Number(user.id), avatar_color: user.avatar_color });
  } catch {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/rooms', async (_, res) => {
  const result = await db.execute('SELECT * FROM rooms ORDER BY id');
  res.json(result.rows);
});

app.get('/api/messages/:roomId', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 80',
    args: [req.params.roomId]
  });
  res.json(result.rows.reverse());
});

app.get('/api/private/:uid1/:uid2', async (req, res) => {
  const { uid1, uid2 } = req.params;
  const result = await db.execute({
    sql: `SELECT * FROM private_messages
          WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
          ORDER BY created_at DESC LIMIT 80`,
    args: [uid1, uid2, uid2, uid1]
  });
  res.json(result.rows.reverse());
});

app.get('/api/users', async (_, res) => {
  const result = await db.execute('SELECT id, username, avatar_color, bio FROM users ORDER BY username');
  res.json(result.rows);
});

const onlineUsers = {};

io.on('connection', (socket) => {

  socket.on('user-online', (userData) => {
    onlineUsers[socket.id] = userData;
    socket.userData = userData;
    io.emit('online-list', Object.values(onlineUsers));
  });

  socket.on('join-room', (roomId) => {
    socket.join(`room-${roomId}`);
  });

  socket.on('send-message', async ({ roomId, text }) => {
    if (!socket.userData || !text.trim()) return;
    const { id, username, avatar_color } = socket.userData;
    try {
      const result = await db.execute({
        sql: 'INSERT INTO messages (room_id, user_id, username, text) VALUES (?, ?, ?, ?)',
        args: [roomId, id, username, text.trim()]
      });
      const msg = {
        id: Number(result.lastInsertRowid),
        room_id: roomId, user_id: id,
        username, avatar_color, text: text.trim(),
        created_at: new Date().toISOString()
      };
      io.to(`room-${roomId}`).emit('new-message', msg);
    } catch {}
  });

  socket.on('send-private', async ({ toId, toUsername, text }) => {
    if (!socket.userData || !text.trim()) return;
    const { id, username, avatar_color } = socket.userData;
    try {
      const result = await db.execute({
        sql: 'INSERT INTO private_messages (from_id, from_username, to_id, to_username, text) VALUES (?, ?, ?, ?, ?)',
        args: [id, username, toId, toUsername, text.trim()]
      });
      const msg = {
        id: Number(result.lastInsertRowid),
        from_id: id, from_username: username,
        to_id: toId, to_username: toUsername,
        avatar_color, text: text.trim(),
        created_at: new Date().toISOString()
      };
      socket.emit('private-message', msg);
      const toSid = Object.keys(onlineUsers).find(sid => onlineUsers[sid].id == toId);
      if (toSid) io.to(toSid).emit('private-message', msg);
    } catch {}
  });

  socket.on('typing', ({ roomId, toId }) => {
    if (!socket.userData) return;
    if (roomId) socket.to(`room-${roomId}`).emit('typing', { username: socket.userData.username, roomId });
    if (toId) {
      const toSid = Object.keys(onlineUsers).find(sid => onlineUsers[sid].id == toId);
      if (toSid) io.to(toSid).emit('typing-private', { from: socket.userData.username, fromId: socket.userData.id });
    }
  });

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    io.emit('online-list', Object.values(onlineUsers));
  });
});

initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('Server on port ' + PORT));
}).catch(console.error);
