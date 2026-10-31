const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const now = () => Date.now();
const token = () => crypto.randomBytes(24).toString('base64url');
const cleanName = value => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
const passwordHash = (password, salt) => crypto.scryptSync(password, salt, 64);

function makeCode() {
  let value;
  do value = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  while (rooms.has(value));
  return value;
}
function broadcast(room) {
  for (const response of room.listeners) response.write('data: update\n\n');
}
function schedule(room) {
  clearTimeout(room.timer);
  const deadlines = [room.prepUntil, room.answerUntil, room.speakerUntil].filter(Boolean);
  if (deadlines.length) room.timer = setTimeout(() => { advance(room); broadcast(room); }, Math.max(0, Math.min(...deadlines) - now()) + 1);
}
function advance(room) {
  const time = now();
  let changed = false;
  if (room.phase === 'preparing' && time >= room.prepUntil) {
    room.phase = 'open'; room.answerUntil = room.prepUntil + 40000; room.prepUntil = null; changed = true;
  }
  if (room.phase === 'open' && room.answerUntil && time >= room.answerUntil) {
    room.phase = 'ended'; room.answerUntil = null; room.answerRemainingMs = 0; changed = true;
  } else if (room.phase === 'speaking' && time >= room.speakerUntil) {
    room.phase = 'speaker-finished'; room.speakerUntil = null; changed = true;
  }
  if (changed) { schedule(room); broadcast(room); }
}
function playerFor(room, auth) { return room.players.find(p => p.token === auth); }
function snapshot(room, auth) {
  advance(room);
  const admin = auth === room.adminToken;
  const player = playerFor(room, auth);
  if (!admin && !player) return null;
  return {
    code: room.code, title: room.title, role: admin ? 'admin' : 'player', me: player?.id,
    phase: room.phase, round: room.round, serverNow: now(),
    prepUntil: room.prepUntil, answerUntil: room.answerUntil, answerRemainingMs: room.answerRemainingMs, speakerUntil: room.speakerUntil,
    speaker: room.players.find(p => p.id === room.speaker)?.name || null,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: now() - p.lastSeen < 5000, pressed: p.pressed }))
  };
}
function displaySnapshot(room) {
  advance(room);
  return { code: room.code, title: room.title, role: 'display', phase: room.phase, round: room.round,
    serverNow: now(), prepUntil: room.prepUntil, answerUntil: room.answerUntil, answerRemainingMs: room.answerRemainingMs,
    speakerUntil: room.speakerUntil,
    speaker: room.players.find(p => p.id === room.speaker)?.name || null,
    players: room.players.map(p => ({ name: p.name })) };
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { send(res, status, { error: message }); }

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/exists') return send(res, 200, { exists: rooms.has((url.searchParams.get('code') || '').toUpperCase()) });
  let body = {};
  if (req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw Error('large'); }
      body = JSON.parse(raw || '{}');
    } catch { return fail(res, 400, 'Некорректный запрос'); }
  }
  if (req.method === 'POST' && url.pathname === '/api/create') {
    const title = String(body.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!title) return fail(res, 400, 'Введите название игры');
    const password = body.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return fail(res, 400, 'Пароль должен содержать от 8 до 128 символов');
    const salt = crypto.randomBytes(16);
    const room = { code: makeCode(), title, adminToken: token(), passwordSalt: salt, passwordHash: passwordHash(password, salt), loginAttempts: new Map(), players: [], listeners: new Set(), phase: 'lobby', round: 0, prepUntil: null, answerUntil: null, answerRemainingMs: null, speakerUntil: null, speaker: null, timer: null };
    rooms.set(room.code, room);
    return send(res, 200, { code: room.code, title, token: room.adminToken });
  }
  const roomCode = String(body.code || url.searchParams.get('code') || '').trim().toUpperCase();
  const room = rooms.get(roomCode);
  if (!room) return fail(res, 404, 'Игра с таким кодом не найдена');
  if (req.method === 'POST' && url.pathname === '/api/admin-login') {
    const address = req.socket.remoteAddress;
    const attempts = room.loginAttempts.get(address) || [];
    const recent = attempts.filter(time => now() - time < 60000);
    if (recent.length >= 10) return fail(res, 429, 'Слишком много попыток. Подождите минуту');
    const password = body.password;
    const valid = typeof password === 'string' && password.length <= 128 && crypto.timingSafeEqual(passwordHash(password, room.passwordSalt), room.passwordHash);
    if (!valid) {
      recent.push(now()); room.loginAttempts.set(address, recent);
      return fail(res, 401, 'Неверный пароль');
    }
    room.loginAttempts.delete(address);
    return send(res, 200, { code: room.code, title: room.title, token: room.adminToken });
  }
  if (req.method === 'GET' && url.pathname === '/api/display') return send(res, 200, displaySnapshot(room));
  if (req.method === 'POST' && url.pathname === '/api/join') {
    if (room.phase !== 'lobby') return fail(res, 409, room.phase === 'finished' ? 'Игра завершена' : 'Игра уже началась');
    const name = cleanName(body.teamName ?? body.name);
    if (!name) return fail(res, 400, 'Введите название команды');
    if (room.players.some(p => p.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) return fail(res, 409, 'Команда с таким названием уже в игре');
    const player = { id: token(), token: token(), name, pressed: false, lastSeen: now() };
    room.players.push(player); broadcast(room);
    return send(res, 200, { code: room.code, token: player.token });
  }
  const auth = req.headers.authorization?.replace(/^Bearer /, '');
  const admin = auth === room.adminToken;
  const player = playerFor(room, auth);
  const display = req.method === 'GET' && url.pathname === '/api/events' && url.searchParams.get('display') === '1';
  if (!admin && !player && !display) return fail(res, 401, 'Сессия не найдена. Войдите снова');
  if (player) player.lastSeen = now();
  advance(room);
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot(room, auth));
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: update\n\n'); room.listeners.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); room.listeners.delete(res); });
    return;
  }
  if (req.method !== 'POST') return fail(res, 404, 'Неизвестный адрес');
  if (url.pathname === '/api/rename-team') {
    if (!player) return fail(res, 403, 'Только для команд');
    if (room.phase === 'finished') return fail(res, 409, 'Игра завершена');
    const name = cleanName(body.teamName);
    if (!name) return fail(res, 400, 'Введите название команды');
    if (room.players.some(p => p.id !== player.id && p.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) return fail(res, 409, 'Команда с таким названием уже в игре');
    player.name = name; broadcast(room);
    return send(res, 200, snapshot(room, auth));
  }
  if (url.pathname === '/api/leave') {
    if (!player) return fail(res, 403, 'Только для команд');
    room.players.splice(room.players.indexOf(player), 1);
    if (room.speaker === player.id) {
      room.speaker = null; room.speakerUntil = null;
      if (room.phase === 'speaking') room.phase = 'speaker-finished';
      schedule(room);
    }
    broadcast(room);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/press') {
    if (!player) return fail(res, 403, 'Только для команд');
    if (room.phase !== 'open' || !room.answerUntil) return fail(res, 409, 'Приём ответов закрыт');
    if (player.pressed) return fail(res, 409, 'Ваша команда уже нажала в этом раунде');
    player.pressed = true;
    room.answerRemainingMs = Math.max(0, room.answerUntil - now()); room.answerUntil = null;
    room.phase = 'speaking'; room.speaker = player.id; room.speakerUntil = now() + 15000; schedule(room);
    broadcast(room);
    return send(res, 200, snapshot(room, auth));
  }
  if (!admin) return fail(res, 403, 'Только для администратора');
  if (url.pathname === '/api/finish-game' && room.phase !== 'finished') {
    room.phase = 'finished'; room.prepUntil = null; room.answerUntil = null; room.answerRemainingMs = null;
    room.speakerUntil = null; room.speaker = null; schedule(room);
  } else if (url.pathname === '/api/start-game' && room.phase === 'lobby' && room.players.length) {
    room.phase = 'ready'; room.round = 1;
  } else if (url.pathname === '/api/start-answer' && room.phase === 'ready' && room.players.length) {
    room.phase = 'preparing'; room.prepUntil = now() + 10000; room.answerRemainingMs = 40000; schedule(room);
  } else if (url.pathname === '/api/continue' && room.phase === 'speaker-finished') {
    room.phase = 'open'; room.speaker = null; room.answerUntil = now() + room.answerRemainingMs;
    schedule(room);
  } else if (url.pathname === '/api/end' && room.phase === 'speaker-finished') {
    room.phase = 'ended'; room.speaker = null; room.answerUntil = null; room.answerRemainingMs = 0; schedule(room);
  } else if (url.pathname === '/api/next' && room.phase === 'ended') {
    room.phase = 'ready'; room.round += 1; room.speaker = null; room.answerRemainingMs = null;
    for (const p of room.players) p.pressed = false;
  } else return fail(res, 409, 'Действие сейчас недоступно');
  broadcast(room); send(res, 200, snapshot(room, auth));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); } catch (error) { console.error(error); if (!res.headersSent) fail(res, 500, 'Ошибка сервера'); }
    return;
  }
  if (url.pathname === '/qr') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
    if (!room) return fail(res, 404, 'Игра не найдена');
    const destination = `${(process.env.PUBLIC_URL || url.origin).replace(/\/$/, '')}/?code=${room.code}`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(await QRCode.toString(destination, { type: 'svg', margin: 2, width: 320, color: { dark: '#10101a', light: '#ffffff' } }));
    return;
  }
  const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(publicDir + path.sep)) return fail(res, 404, 'Не найдено');
  fs.readFile(file, (error, content) => {
    if (error) return fail(res, 404, 'Не найдено');
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content);
  });
});
if (require.main === module) server.listen(port, '0.0.0.0', () => console.log(`Local: http://localhost:${port}`));
module.exports = { server, rooms };
