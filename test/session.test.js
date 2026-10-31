const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const session = { code: 'ABCDE', token: 'admin-token', role: 'admin' };
const storage = initial => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
};

async function open(phase, sessionStorage, localStorage) {
  const root = { innerHTML: '' };
  const document = {
    title: '', body: { classList: { toggle() {} } },
    querySelector: selector => selector === '#app' ? root : selector === '#connection' ? { hidden: true } : null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const snapshot = { code: session.code, title: 'Квиз', role: 'admin', phase, round: 1, players: [], prepSeconds: 10, answerSeconds: 15, roundSeconds: 40, serverNow: Date.now() };
  const fetch = async url => url.startsWith('/api/state') ? { ok: true, json: async () => snapshot } : { ok: false };
  vm.runInNewContext(app, { document, location: { search: '' }, history: { replaceState() {} }, sessionStorage, localStorage, fetch, URLSearchParams, AbortController, setInterval() {}, setTimeout() {} });
  await new Promise(setImmediate);
  return root.innerHTML;
}

test('завершённая игра не возвращает ведущего после открытия главной', async () => {
  const sessionStorage = storage({ 'pulse-session': JSON.stringify(session) });
  const localStorage = storage({ 'pulse-sessions': JSON.stringify([session]) });
  assert.match(await open('finished', sessionStorage, localStorage), /На главную/);
  assert.equal(sessionStorage.getItem('pulse-session'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem('pulse-sessions')), []);
  assert.match(await open('finished', sessionStorage, localStorage), /Создать игру/);
});

test('активная игра остаётся доступной после обновления страницы', async () => {
  const sessionStorage = storage({ 'pulse-session': JSON.stringify(session) });
  const localStorage = storage({ 'pulse-sessions': JSON.stringify([session]) });
  assert.match(await open('ready', sessionStorage, localStorage), /Начать ответ/);
  assert.ok(sessionStorage.getItem('pulse-session'));
  assert.equal(JSON.parse(localStorage.getItem('pulse-sessions')).length, 1);
});
