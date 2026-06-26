const socket = io();

let me = null;
let currentChat = null;
let allRooms = [];
let allUsers = [];
let onlineIds = new Set();
let typingTimer = null;

const $ = id => document.getElementById(id);

// ─── AUTH ───────────────────────────────────────────────
let authMode = 'login';
function switchTab(mode) {
  authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('auth-btn').textContent = mode === 'login' ? 'دخول' : 'إنشاء حساب';
  $('auth-err').textContent = '';
}

async function doAuth() {
  const username = $('a-username').value.trim();
  const password = $('a-password').value.trim();
  $('auth-err').textContent = '';
  if (!username || !password) { $('auth-err').textContent = 'أدخل اسم المستخدم وكلمة المرور'; return; }

  const res = await fetch(`/api/${authMode}`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!res.ok) { $('auth-err').textContent = data.error; return; }

  me = data;
  localStorage.setItem('me', JSON.stringify(me));
  startApp();
}

function logout() {
  localStorage.removeItem('me');
  location.reload();
}

// ─── STARTUP ────────────────────────────────────────────
window.onload = () => {
  const saved = localStorage.getItem('me');
  if (saved) { me = JSON.parse(saved); startApp(); }
};

async function startApp() {
  $('auth-screen').style.display = 'none';
  $('app').classList.remove('hidden');

  $('my-username').textContent = me.username;
  const av = $('my-avatar');
  av.style.background = me.avatar_color;
  av.textContent = me.username[0].toUpperCase();

  socket.emit('user-online', { id: me.id, username: me.username, avatar_color: me.avatar_color });

  const [roomsRes, usersRes] = await Promise.all([fetch('/api/rooms'), fetch('/api/users')]);
  allRooms = await roomsRes.json();
  allUsers = await usersRes.json();

  renderChatList();
}

// ─── RENDER SIDEBAR ─────────────────────────────────────
function renderChatList(filter = '') {
  const list = $('chat-list');
  list.innerHTML = '';

  const fl = filter.toLowerCase();

  // Rooms section
  const filteredRooms = allRooms.filter(r => !fl || r.name.includes(fl));
  if (filteredRooms.length) {
    list.innerHTML += `<div class="section-label">الغرف العامة</div>`;
    filteredRooms.forEach(room => {
      const active = currentChat?.type === 'room' && currentChat.id == room.id ? 'active' : '';
      list.innerHTML += `
        <div class="chat-item ${active}" onclick="openRoom(${room.id},'${room.name}')">
          <div class="avatar sm" style="background:var(--blue)">#</div>
          <div class="info">
            <div class="name">${room.name}</div>
            <div class="preview">${room.description}</div>
          </div>
        </div>`;
    });
  }

  // Users section
  const filteredUsers = allUsers.filter(u => u.id != me.id && (!fl || u.username.includes(fl)));
  if (filteredUsers.length) {
    list.innerHTML += `<div class="section-label">المستخدمون</div>`;
    filteredUsers.forEach(user => {
      const online = onlineIds.has(user.id);
      const active = currentChat?.type === 'private' && currentChat.id == user.id ? 'active' : '';
      list.innerHTML += `
        <div class="chat-item ${active}" onclick="openPrivate(${user.id},'${user.username}','${user.avatar_color}')">
          <div style="position:relative;display:inline-block">
            <div class="avatar sm" style="background:${user.avatar_color}">${user.username[0].toUpperCase()}</div>
            ${online ? '<div class="online-dot"></div>' : ''}
          </div>
          <div class="info">
            <div class="name">${user.username}</div>
            <div class="preview">${online ? '🟢 متصل الآن' : 'غير متصل'}</div>
          </div>
        </div>`;
    });
  }
}

function filterChats() {
  renderChatList($('search-inp').value);
}

// ─── OPEN ROOM ──────────────────────────────────────────
async function openRoom(id, name) {
  currentChat = { type: 'room', id, name };
  showChatView();
  $('chat-name').textContent = '# ' + name;
  $('chat-status').textContent = 'غرفة عامة';
  const av = $('chat-avatar');
  av.style.background = 'var(--blue)';
  av.textContent = '#';

  socket.emit('join-room', id);
  const res = await fetch(`/api/messages/${id}`);
  const msgs = await res.json();
  renderMessages(msgs, 'room');
  renderChatList($('search-inp').value);
  if (window.innerWidth <= 700) mobileSwitchToChat();
}

// ─── OPEN PRIVATE ───────────────────────────────────────
async function openPrivate(id, username, avatar_color) {
  currentChat = { type: 'private', id, username, avatar_color };
  showChatView();
  $('chat-name').textContent = username;
  const online = onlineIds.has(id);
  $('chat-status').textContent = online ? '🟢 متصل الآن' : 'غير متصل';
  const av = $('chat-avatar');
  av.style.background = avatar_color;
  av.textContent = username[0].toUpperCase();

  const res = await fetch(`/api/private/${me.id}/${id}`);
  const msgs = await res.json();
  renderMessages(msgs, 'private');
  renderChatList($('search-inp').value);
  if (window.innerWidth <= 700) mobileSwitchToChat();
}

// ─── RENDER MESSAGES ────────────────────────────────────
function renderMessages(msgs, type) {
  const area = $('messages-area');
  area.innerHTML = '';
  if (!msgs.length) {
    area.innerHTML = '<div style="text-align:center;color:var(--sub);margin-top:40px;font-size:14px">لا توجد رسائل بعد. كن أول من يكتب! 👋</div>';
    return;
  }

  let lastDate = '';
  let lastSender = null;

  msgs.forEach(msg => {
    const isMe = type === 'room' ? msg.user_id == me.id : msg.from_id == me.id;
    const sender = type === 'room' ? msg.username : msg.from_username;
    const color = msg.avatar_color || '#5cabf2';
    const dateStr = formatDate(msg.created_at);
    const timeStr = formatTime(msg.created_at);

    if (dateStr !== lastDate) {
      area.innerHTML += `<div class="date-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
      lastSender = null;
    }

    const showAvatar = !isMe && sender !== lastSender;
    lastSender = sender;

    area.innerHTML += `
      <div class="msg-group ${isMe ? 'me' : 'other'}">
        <div class="msg-row">
          ${!isMe && showAvatar ? `<div class="avatar xs" style="background:${color}">${sender[0].toUpperCase()}</div>` : (!isMe ? '<div style="width:28px"></div>' : '')}
          <div>
            ${!isMe && showAvatar ? `<div class="msg-sender">${sender}</div>` : ''}
            <div class="msg-bubble">${escHtml(msg.text)}</div>
            <div class="msg-time">${timeStr}</div>
          </div>
        </div>
      </div>`;
  });

  area.scrollTop = area.scrollHeight;
}

function appendMsg(msg, type) {
  const area = $('messages-area');
  const noMsg = area.querySelector('div[style*="text-align:center"]');
  if (noMsg) noMsg.remove();

  const isMe = type === 'room' ? msg.user_id == me.id : msg.from_id == me.id;
  const sender = type === 'room' ? msg.username : msg.from_username;
  const color = msg.avatar_color || '#5cabf2';
  const timeStr = formatTime(msg.created_at || new Date().toISOString());

  area.innerHTML += `
    <div class="msg-group ${isMe ? 'me' : 'other'}">
      <div class="msg-row">
        ${!isMe ? `<div class="avatar xs" style="background:${color}">${sender[0].toUpperCase()}</div>` : ''}
        <div>
          ${!isMe ? `<div class="msg-sender">${sender}</div>` : ''}
          <div class="msg-bubble">${escHtml(msg.text)}</div>
          <div class="msg-time">${timeStr}</div>
        </div>
      </div>
    </div>`;

  area.scrollTop = area.scrollHeight;
}

// ─── SEND ────────────────────────────────────────────────
function sendMsg() {
  const text = $('msg-inp').value.trim();
  if (!text || !currentChat) return;
  $('msg-inp').value = '';

  if (currentChat.type === 'room') {
    socket.emit('send-message', { roomId: currentChat.id, text });
  } else {
    socket.emit('send-private', { toId: currentChat.id, toUsername: currentChat.username, text });
  }
}

// ─── TYPING ──────────────────────────────────────────────
function onTyping() {
  if (!currentChat) return;
  clearTimeout(typingTimer);
  if (currentChat.type === 'room') socket.emit('typing', { roomId: currentChat.id });
  else socket.emit('typing', { toId: currentChat.id });
  typingTimer = setTimeout(() => {}, 2000);
}

// ─── SOCKET EVENTS ───────────────────────────────────────
socket.on('online-list', users => {
  onlineIds = new Set(users.map(u => u.id));
  renderChatList($('search-inp').value);
  if (currentChat?.type === 'private') {
    const online = onlineIds.has(currentChat.id);
    $('chat-status').textContent = online ? '🟢 متصل الآن' : 'غير متصل';
  }
});

socket.on('new-message', msg => {
  if (currentChat?.type === 'room' && msg.room_id == currentChat.id) {
    appendMsg(msg, 'room');
  }
});

socket.on('private-message', msg => {
  const otherId = msg.from_id == me.id ? msg.to_id : msg.from_id;
  if (currentChat?.type === 'private' && otherId == currentChat.id) {
    appendMsg(msg, 'private');
  }
});

socket.on('typing', ({ username, roomId }) => {
  if (currentChat?.type === 'room' && roomId == currentChat.id && username !== me.username) {
    showTyping(`${username} يكتب...`);
  }
});

socket.on('typing-private', ({ from, fromId }) => {
  if (currentChat?.type === 'private' && fromId == currentChat.id) {
    showTyping(`${from} يكتب...`);
  }
});

let typingHide;
function showTyping(text) {
  const el = $('typing-indicator');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(typingHide);
  typingHide = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ─── UI HELPERS ──────────────────────────────────────────
function showChatView() {
  $('empty-state').classList.add('hidden');
  $('chat-view').classList.remove('hidden');
  $('messages-area').innerHTML = '';
}

function goBack() {
  $('chat-view').classList.add('mobile-active', 'hidden');
  $('sidebar').classList.remove('hidden-mobile');
  currentChat = null;
}

function mobileSwitchToChat() {
  $('sidebar').classList.add('hidden-mobile');
  $('chat-view').classList.add('mobile-active');
  $('chat-view').classList.remove('hidden');
}

function toggleMenu() {
  $('user-menu').classList.toggle('hidden');
}

document.addEventListener('click', e => {
  if (!$('menu-btn').contains(e.target) && !$('user-menu').contains(e.target))
    $('user-menu').classList.add('hidden');
});

function formatDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'اليوم';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'أمس';
  return d.toLocaleDateString('ar', { day: 'numeric', month: 'long' });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\n/g,'<br>');
}
