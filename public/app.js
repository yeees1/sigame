const root = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const displayCode = params.get('display')?.toUpperCase();
let session;
try { session = JSON.parse(sessionStorage.getItem('pulse-session') || 'null'); } catch { session = null; }
let state = null;
let clockOffset = 0;
let busy = false;
let leaving = false;
let streamController;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const remaining = deadline => Math.max(0, (deadline - (Date.now() + clockOffset)) / 1000);
const number = deadline => Math.ceil(remaining(deadline)).toString().padStart(2, '0');
function savedSessions() {
  try { const saved = JSON.parse(localStorage.getItem('pulse-sessions') || '[]'); return Array.isArray(saved) ? saved : []; }
  catch { return []; }
}
function availableSessions() {
  const code = params.get('code')?.toUpperCase();
  return savedSessions().filter(saved => !code || (saved.code === code && saved.role === 'player'));
}
function rememberSession(value) {
  localStorage.setItem('pulse-sessions', JSON.stringify([value, ...savedSessions().filter(saved => saved.token !== value.token)]));
}
function forgetSession(value) {
  localStorage.setItem('pulse-sessions', JSON.stringify(savedSessions().filter(saved => saved.token !== value.token)));
}

async function request(path, options = {}, auth = true) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(auth && session ? { Authorization: `Bearer ${session.token}` } : {}) }
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Не удалось выполнить действие');
  return data;
}
function saveSession(value) {
  if (session && state?.phase === 'finished') forgetSession(session);
  session = value;
  sessionStorage.setItem('pulse-session', JSON.stringify(value));
  rememberSession(value);
  history.replaceState({}, '', '/');
  run();
}
function resumeSession(value) {
  session = value;
  sessionStorage.setItem('pulse-session', JSON.stringify(value));
  history.replaceState({}, '', '/');
  run();
}
function heading(kicker, title, extra = '') {
  return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2></div>${extra}</div>`;
}
function button(label, action, primary = false, disabled = false) {
  return `<button type="button" class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
}
function home() {
  root.innerHTML = `<section class="hero animate-in"><div><div class="eyebrow">ИГРА НА ОСТРИЕ МОМЕНТА</div><h1>Знаете?<br><em>Нажимайте.</em></h1><p class="lead">Живая викторина, в которой всё решает момент. Соберите команды, задавайте вопросы вслух и узнайте, какая команда ответит первой.</p><div class="hero-actions"><button class="btn btn-primary" data-action="create">Создать игру <span class="arrow">→</span></button><button class="btn btn-ghost" data-action="join-screen">Войти командой <span class="arrow">→</span></button><button class="btn btn-ghost" data-action="admin-login-screen">Войти как администратор <span class="arrow">→</span></button></div></div><div class="hero-card" aria-hidden="true"><span class="card-label">ПУЛЬС / LIVE GAME</span><span class="tiny">● В ЭФИРЕ</span><div class="orb">?</div><div class="hero-card-bottom"><b>ВАШ ВЫХОД<br>БЫТЬ ПЕРВЫМИ</b><span>01:40<br>СЕКУНДЫ РЕШАЮТ</span></div></div></section><section class="steps"><div class="step"><b>01 /</b><h3>Создайте комнату</h3><p>Код и QR для быстрого подключения команд.</p></div><div class="step"><b>02 /</b><h3>Задайте вопрос</h3><p>Ведущий зачитывает вопрос и запускает отсчёт.</p></div><div class="step"><b>03 /</b><h3>Ловите момент</h3><p>Первое нажатие получает право ответить вслух.</p></div></section>`;
}
function createScreen(message = '') {
  root.innerHTML = `<section class="page animate-in">${heading('НОВАЯ ИГРА', 'Назовите <em>игру</em>')}<form id="create-form" class="card join-card"><p class="sub">Название увидят команды и зрители на главном экране.</p><label class="field"><span>Название игры</span><input name="title" maxlength="60" required autocomplete="off" placeholder="Например, Большой квиз"></label><label class="field"><span>Пароль администратора</span><input name="password" type="password" minlength="8" maxlength="128" required autocomplete="new-password" placeholder="Не менее 8 символов"></label><p class="error" role="alert">${escapeHtml(message)}</p><button class="btn btn-primary" type="submit">Создать игру →</button></form></section>`;
}
function adminLoginScreen(code = '', message = '') {
  root.innerHTML = `<section class="page animate-in">${heading('ВОЗВРАЩЕНИЕ ВЕДУЩЕГО', 'Войти как <em>администратор</em>')}<form id="admin-login-form" class="card join-card"><p class="sub">Введите код игры и пароль, который вы задали при создании.</p><label class="field"><span>Код игры</span><input class="code-input" name="code" maxlength="5" pattern="[A-Za-z0-9]{5}" required autocomplete="off" value="${escapeHtml(code)}" placeholder="ABCDE"></label><label class="field"><span>Пароль администратора</span><input name="password" type="password" required autocomplete="current-password"></label><p class="error" role="alert">${escapeHtml(message)}</p><button class="btn btn-primary" type="submit">Войти в игру →</button></form></section>`;
}
function joinScreen(code = '', message = '') {
  root.innerHTML = `<section class="page animate-in">${heading('ПОДКЛЮЧЕНИЕ', 'Войти в <em>игру</em>')}<form id="join-form" class="card join-card"><p class="sub">Введите код комнаты и название команды, которое увидят остальные.</p><label class="field"><span>Код игры</span><input class="code-input" name="code" maxlength="5" pattern="[A-Za-z0-9]{5}" required autocomplete="off" value="${escapeHtml(code)}" placeholder="ABCDE"></label><label class="field"><span>Название команды</span><input name="teamName" maxlength="32" required autocomplete="off" placeholder="Например, Молния"></label><p class="error" role="alert">${escapeHtml(message)}</p><button class="btn btn-primary" type="submit">Присоединиться <span class="arrow">→</span></button><div class="control-row">${button('Войти как администратор', 'admin-login-screen')}</div></form></section>`;
}
function resumeScreen(sessions) {
  root.innerHTML = `<section class="page animate-in">${heading('С ВОЗВРАЩЕНИЕМ', 'Продолжить <em>игру</em>')}<div class="card join-card"><p class="sub">Выберите свою роль на этом устройстве.</p><div class="control-row">${sessions.map((saved, index) => `<button class="btn btn-ghost" data-action="resume" data-index="${index}">${saved.role === 'admin' ? 'Ведущий' : escapeHtml(saved.name || 'Команда')} · ${escapeHtml(saved.code)}</button>`).join('')}</div><div class="control-row">${button('Новая игра →', 'create', true)}${button('Войти по коду', 'join-screen')}${button('Войти как администратор', 'admin-login-screen')}</div></div></section>`;
}
function playersMarkup(players) {
  if (!players?.length) return '<p class="sub">Пока команд нет. Покажите QR-код или отправьте код игры.</p>';
  return `<div class="players-list">${players.map(p => `<span class="player-chip ${p.connected === false ? 'offline' : ''} ${p.pressed ? 'pressed' : ''}"><i></i>${escapeHtml(p.name)}</span>`).join('')}</div>`;
}
function lobby() {
  const admin = state.role === 'admin';
  root.innerHTML = `<section class="page animate-in">${heading('КОМНАТА СОЗДАНА', escapeHtml(state.title), `<span class="status"><span class="live-dot"></span> ОЖИДАНИЕ КОМАНД</span>`)}<div class="grid"><div class="card qr-card"><div class="card-label">СКАНИРУЙТЕ, ЧТОБЫ ВОЙТИ</div><div class="qr-frame"><img src="/qr?code=${state.code}" alt="QR-код для подключения к игре"></div><p class="sub">Или введите код вручную</p><div class="game-code">${state.code}</div><button class="copy" data-action="copy">Скопировать ссылку</button></div><div class="card"><div class="card-label">КОМАНД В ИГРЕ · ${state.players.length}</div><h2 style="font-size:36px;margin-top:24px">Все на месте?</h2>${playersMarkup(state.players)}<div class="control-row">${admin ? `${button('Начать игру →', 'start-game', true, !state.players.length)}${button('Завершить игру', 'finish-game')}` : `<p class="sub">Ведущий скоро запустит игру. Оставайтесь на странице.</p>${button('Сменить название команды', 'rename-team')}${button('Выйти из игры', 'leave')}`}</div></div></div></section>`;
}
function stageData() {
  switch (state.phase) {
    case 'ready': return ['ВОПРОС У ВЕДУЩЕГО', `Раунд <em>${state.round}</em>`, 'Ведущий зачитывает вопрос вслух. Команды готовятся отвечать.'];
    case 'preparing': return ['ПОДГОТОВКА', 'Приготовьтесь<br>к <em>ответу</em>', 'Кнопка откроется одновременно для всех через 10 секунд.'];
    case 'open': return ['ПРИЁМ ОТВЕТОВ', 'Время <em>нажимать</em>', 'Первая нажавшая команда получает право ответить.'];
    case 'speaking': return ['ОТВЕЧАЕТ КОМАНДА', escapeHtml(state.speaker), `Слушаем ответ команды. Приём нажатий на паузе, осталось ${Math.ceil(state.answerRemainingMs / 1000)} с.`];
    case 'speaker-finished': return ['ОТВЕТ ЗАВЕРШЁН', state.speaker ? escapeHtml(state.speaker) : 'Команда вышла', `Ведущий выбирает: продолжить приём нажатий (${Math.ceil(state.answerRemainingMs / 1000)} с) или завершить раунд.`];
    case 'finished': return ['ИГРА ЗАВЕРШЕНА', 'Спасибо за <em>игру</em>', 'Ведущий завершил игру. Ответы больше не принимаются.'];
    default: return ['РАУНД ЗАВЕРШЁН', 'Пауза между<br><em>раундами</em>', 'Все нажатия этого раунда закрыты.'];
  }
}
function game() {
  const [kicker, title, desc] = stageData();
  const admin = state.role === 'admin';
  const display = state.role === 'display';
  const me = state.players?.find(p => p.id === state.me);
  const timerDeadline = state.phase === 'preparing' ? state.prepUntil : state.phase === 'speaking' ? state.speakerUntil : state.phase === 'open' ? state.answerUntil : null;
  const showAnswer = !admin && !display && state.phase === 'open';
  const action = admin ? (state.phase === 'ready' ? button('Начать ответ →', 'start-answer', true, !state.players.length) : state.phase === 'open' ? button('Завершить раунд', 'end') : state.phase === 'speaking' ? button('Завершить ответ', 'finish-answer') : state.phase === 'speaker-finished' ? `${button('Продолжить ответ →', 'continue', true)}${button('Завершить раунд', 'end')}` : state.phase === 'ended' ? button('Следующий раунд →', 'next', true) : '') : '';
  const gameActions = state.phase === 'finished' ? (admin ? button('Создать новую игру →', 'create', true) : button('На главную →', 'leave', true)) : admin ? `${action}${button('Завершить игру', 'finish-game')}` : `${button('Сменить название команды', 'rename-team')}${button('Выйти из игры', 'leave')}`;
  root.innerHTML = `<section class="page ${display ? 'display-mode' : ''}"><div class="page-head"><div><div class="eyebrow">${display ? 'ГЛАВНЫЙ ЭКРАН' : admin ? 'ПАНЕЛЬ ВЕДУЩЕГО' : 'ЭКРАН КОМАНДЫ'}</div><h2 class="game-heading">${escapeHtml(state.title)}</h2></div><div class="round-tag">${state.phase === 'finished' ? 'ИГРА ЗАВЕРШЕНА' : `РАУНД ${state.round}`}　/　КОД ${state.code}</div></div><div class="${display ? '' : 'game-layout'}"><div><div class="card main-stage"><div class="stage-kicker">● ${kicker}</div><div class="stage-title">${title}</div><p class="stage-desc">${desc}</p>${timerDeadline ? `<div class="timer" data-timer="${timerDeadline}">${number(timerDeadline)}</div><div class="progress"><span data-progress="${timerDeadline}"></span></div>` : ''}</div>${showAnswer ? `<button class="btn btn-primary answer-button" data-action="press" ${me?.pressed ? 'disabled' : ''}>${me?.pressed ? 'Команда уже нажала' : 'Ответить'}</button>` : ''}${!admin && !display && state.phase === 'preparing' ? '<p class="sub" style="margin-top:20px">Кнопка ответа пока заблокирована.</p>' : ''}${!display && gameActions ? `<div class="control-row">${gameActions}</div>` : ''}</div>${display ? '' : `<aside class="side-card"><div class="card"><div class="card-label">КОМАНДЫ · ${state.players.length}</div>${playersMarkup(state.players)}</div>${admin ? `<a class="btn btn-ghost" href="/?display=${state.code}" target="_blank" rel="noopener">Открыть экран игры →</a>` : ''}</aside>`}</div>${display ? `<div class="display-meta"><span>ПУЛЬС / LIVE</span><span class="small-code">${state.code}</span></div>` : ''}</section>`;
  updateTimers();
}
function updateTimers() {
  if (!state) return;
  for (const el of document.querySelectorAll('[data-timer]')) el.textContent = number(Number(el.dataset.timer));
  for (const el of document.querySelectorAll('[data-progress]')) {
    const deadline = Number(el.dataset.progress);
    const duration = state.phase === 'preparing' ? 10 : state.phase === 'speaking' ? 15 : 40;
    el.style.width = `${Math.min(100, remaining(deadline) / duration * 100)}%`;
  }
}
function render() {
  if (!state) return;
  document.body.classList.toggle('display-mode', state.role === 'display');
  if (state.phase === 'lobby') lobby(); else game();
}
async function load() {
  if (leaving || (!session && !displayCode)) return;
  try {
    const started = Date.now();
    const next = displayCode ? await request(`/api/display?code=${displayCode}`, {}, false) : await request(`/api/state?code=${session.code}`);
    if (leaving) return;
    clockOffset = next.serverNow - (started + Date.now()) / 2;
    const changed = JSON.stringify({ ...next, serverNow: 0 }) !== JSON.stringify({ ...state, serverNow: 0 });
    state = next;
    document.title = `${next.title || 'Пульс'} — Пульс`;
    if (session) {
      const name = next.players.find(p => p.id === next.me)?.name;
      if (session.role !== next.role || session.name !== name || session.title !== next.title || !savedSessions().some(saved => saved.token === session.token)) {
        session = { ...session, role: next.role, name, title: next.title };
        sessionStorage.setItem('pulse-session', JSON.stringify(session));
        rememberSession(session);
      }
    }
    document.querySelector('#connection').hidden = true;
    if (changed) render();
  } catch (error) {
    if (leaving) return;
    document.querySelector('#connection').hidden = false;
    if (error.message.includes('Сессия не найдена') || error.message.includes('не найдена')) {
      const code = session?.code || params.get('code') || '';
      if (session) forgetSession(session);
      sessionStorage.removeItem('pulse-session'); session = null; state = null;
      joinScreen(code, error.message);
    }
  }
}
async function stream() {
  if (!session && !displayCode) return;
  streamController?.abort(); streamController = new AbortController();
  try {
    const response = await fetch(`/api/events?code=${displayCode || session.code}${displayCode ? '&display=1' : ''}`, { headers: session ? { Authorization: `Bearer ${session.token}` } : {}, signal: streamController.signal });
    if (!response.ok) return;
    const reader = response.body.getReader(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += new TextDecoder().decode(value, { stream: true });
      if (buffer.includes('\n\n')) { buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2); await load(); }
    }
  } catch { /* polling keeps the screen updated */ }
  if ((session || displayCode) && !streamController.signal.aborted) setTimeout(stream, 1500);
}
function run() {
  if (displayCode || session) { load(); stream(); }
  else {
    const saved = availableSessions();
    if (saved.length === 1) return resumeSession(saved[0]);
    if (saved.length > 1) return resumeScreen(saved);
    if (params.get('code')) joinScreen(params.get('code').toUpperCase());
    else home();
  }
}
async function action(name, index) {
  if (busy) return; busy = true;
  try {
    if (name === 'join-screen') return joinScreen();
    if (name === 'admin-login-screen') return adminLoginScreen(document.querySelector('#join-form [name=code]')?.value || params.get('code')?.toUpperCase() || state?.code || '');
    if (name === 'rename-team') { const dialog = document.querySelector('#rename-dialog'); dialog.querySelector('[name=teamName]').value = session.name || ''; dialog.querySelector('.error').textContent = ''; return dialog.showModal(); }
    if (name === 'close-rename') return document.querySelector('#rename-dialog').close();
    if (name === 'resume') return resumeSession(availableSessions()[index]);
    if (name === 'leave') {
      const current = session;
      leaving = true;
      try {
        if (current.role === 'player') await request('/api/leave', { method: 'POST', body: JSON.stringify({ code: current.code }) });
        forgetSession(current); sessionStorage.removeItem('pulse-session'); session = null;
        streamController?.abort(); state = null; history.replaceState({}, '', '/');
        document.title = 'Пульс — живая викторина';
        document.querySelector('#connection').hidden = true;
        return home();
      } finally { leaving = false; }
    }
    if (name === 'copy') { await navigator.clipboard.writeText(`${location.origin}/?code=${state.code}`); return; }
    if (name === 'create') return createScreen();
    await request(`/api/${name}`, { method: 'POST', body: JSON.stringify({ code: session.code }) });
    await load();
  } catch (error) { alert(error.message); await load(); }
  finally { busy = false; }
}
document.addEventListener('click', event => { const target = event.target.closest('[data-action]'); if (target) action(target.dataset.action, Number(target.dataset.index)); });
document.addEventListener('submit', async event => {
  if (!['join-form', 'create-form', 'rename-form', 'admin-login-form'].includes(event.target.id)) return;
  event.preventDefault();
  const data = new FormData(event.target);
  if (event.target.id === 'create-form') {
    const title = String(data.get('title')).trim();
    const password = String(data.get('password'));
    try { saveSession({ ...await request('/api/create', { method: 'POST', body: JSON.stringify({ title, password }) }, false), role: 'admin' }); }
    catch (error) { createScreen(error.message); }
    return;
  }
  if (event.target.id === 'rename-form') {
    const teamName = String(data.get('teamName')).trim();
    try {
      await request('/api/rename-team', { method: 'POST', body: JSON.stringify({ code: session.code, teamName }) });
      document.querySelector('#rename-dialog').close();
      await load();
    } catch (error) { event.target.querySelector('.error').textContent = error.message; }
    return;
  }
  const code = String(data.get('code')).trim().toUpperCase();
  if (event.target.id === 'admin-login-form') {
    try { saveSession({ ...await request('/api/admin-login', { method: 'POST', body: JSON.stringify({ code, password: String(data.get('password')) }) }, false), role: 'admin' }); }
    catch (error) { adminLoginScreen(code, error.message); }
    return;
  }
  const teamName = String(data.get('teamName')).trim();
  try { saveSession({ ...await request('/api/join', { method: 'POST', body: JSON.stringify({ code, teamName }) }, false), role: 'player', name: teamName }); }
  catch (error) { joinScreen(code, error.message); }
});
setInterval(updateTimers, 100);
setInterval(load, 2000);
run();
