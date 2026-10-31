// AI 日程 · 网页 App。后台是 Google Apps Script（apps-script/Code.gs），这里只负责界面。
const API = 'https://script.google.com/macros/s/AKfycbwEtT_UYhShFJcmSjEg-0163SekKB2sU7acnqHLY27gqf4QM2PCGMBhX1zHVaWTVldJZw/exec';

const OTHER = { name: '其他', color: '#8e8e93' };
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const $ = (id) => document.getElementById(id);
const input = $('input'), send = $('send');

// localStorage 在隐私模式等情况下可能抛错，统一包一层
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } },
};

const state = {
  token: store.get('token'),
  lang: store.get('lang') || 'zh-CN',
  year: new Date().getFullYear(),
  month: new Date().getMonth(),   // 0-11
  selected: null,                 // 'yyyy-MM-dd'
  category: '',                   // 创建时指定分类，'' = AI 自动判断
  hidden: new Set(),              // 被筛掉的分类
  data: null,
  categories: [
    { name: '日常', color: '#16a765' }, { name: '工作', color: '#4986e7' }, { name: '重要', color: '#f83a22' },
  ],
};

// ---------- 工具 ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 调后台。用 text/plain 发送，避免跨域预检（Apps Script 不支持 OPTIONS） */
async function api(action, ...args) {
  const res = await fetch(API, {
    method: 'POST',
    body: JSON.stringify({ token: state.token, action, args }),
  });
  const j = await res.json();
  if (!j.ok) {
    const err = new Error(j.error || '请求失败');
    err.auth = j.auth === false;
    throw err;
  }
  return j.data;
}

function handleError(e, box) {
  if (e.auth) { logout('密码失效，请重新输入'); return; }
  const msg = navigator.onLine ? (e.message || String(e)) : '没有网络';
  if (box) { box.innerHTML = ''; box.appendChild(el('div', 'empty err', '出错了：' + msg)); }
  else alert('出错了：' + msg);
}

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayLabel = (k) => { const d = fromKey(k); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WD[d.getDay()]; };
const colorOf = (name) => (state.categories.find((c) => c.name === name) || OTHER).color;
const visible = (x) => !state.hidden.has(x.category);

// ---------- 登录 ----------

function showGate(msg) {
  $('app').classList.add('hidden');
  $('fab').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('gateMsg').textContent = msg || '';
  $('tokenInput').focus();
}

function showApp() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('fab').classList.toggle('hidden', !Recognition);
}

function logout(msg) {
  state.token = null;
  store.del('token');
  store.del('cache');
  showGate(msg);
}

$('tokenSave').onclick = async () => {
  const t = $('tokenInput').value.replace(/\s/g, '').toLowerCase();
  if (!t) return;
  $('tokenSave').disabled = true; $('gateMsg').textContent = '验证中…';
  state.token = t;
  try {
    await api('ping');
    store.set('token', t);
    $('tokenInput').value = '';
    start();
  } catch (e) {
    state.token = null;
    $('gateMsg').textContent = e.auth ? '密码不对' : '连接失败：' + (e.message || e);
  } finally {
    $('tokenSave').disabled = false;
  }
};
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('tokenSave').click(); });

// ---------- 设置 ----------

$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('langSel').value = state.lang;
$('langSel').onchange = () => { state.lang = $('langSel').value; store.set('lang', state.lang); };
$('logout').onclick = () => { if (confirm('在这台设备上退出？需要重新输入密码才能再进来。')) logout(); };

// ---------- 输入区 ----------

function buildCategorySeg() {
  const seg = $('catSeg'); seg.innerHTML = '';
  [['', '自动分类']].concat(state.categories.map((c) => [c.name, c.name])).forEach(([val, label]) => {
    const b = el('button', val === state.category ? 'on' : '');
    if (val) { const d = el('span', 'dot'); d.style.background = colorOf(val); b.appendChild(d); }
    b.appendChild(document.createTextNode(label));
    b.onclick = () => {
      state.category = val;
      [...seg.children].forEach((x) => x.classList.toggle('on', x === b));
    };
    seg.appendChild(b);
  });
}

async function submit(textArg) {
  const text = (textArg || input.value).trim();
  if (!text) return;
  send.disabled = true; send.textContent = '识别中…';
  const box = $('result'); box.innerHTML = '';
  try {
    const items = await api('processInput', text, state.category);
    const card = el('div', 'card');
    items.forEach((r) => card.appendChild(resultRow(r)));
    box.appendChild(card);
    if (items.some((r) => r.ok)) input.value = '';
    load();
  } catch (e) {
    if (e.auth) return handleError(e);
    input.value = text;   // 失败时把内容留着，方便改了再发
    box.appendChild(el('div', 'card err', '出错了：' + (e.message || e)));
  } finally {
    send.disabled = false; send.textContent = '创建';
  }
}

function tag(category, color) {
  const t = el('span', 'tag', category);
  t.style.background = color || colorOf(category);
  return t;
}

function resultRow(r) {
  const row = el('div', 'item');
  const body = el('div', 'body');
  if (!r.ok) {
    body.appendChild(el('div', 'title err', '✗ ' + (r.title || '未创建')));
    body.appendChild(el('div', 'meta', r.error));
    row.appendChild(body);
    return row;
  }
  const title = el('div', 'title');
  title.appendChild(el('span', 'ok', '✓ '));
  title.appendChild(tag(r.category, r.color));
  title.appendChild(document.createTextNode((r.kind === 'event' ? '' : '[待办] ') + r.title));
  body.appendChild(title);
  body.appendChild(el('div', 'meta', [r.when, r.reminder, r.repeat].filter(Boolean).join(' · ')));
  row.appendChild(body);

  if (r.link) {
    const a = el('a', 'ghost', '查看');
    a.href = r.link; a.target = '_blank'; a.rel = 'noopener';
    row.appendChild(a);
  }
  const u = el('button', 'ghost', '撤销');
  u.onclick = async () => {
    u.disabled = true;
    try {
      await api('undo', r.kind, r.container, r.id);
      row.style.opacity = .4; u.textContent = '已撤销';
      load();
    } catch (e) { u.disabled = false; handleError(e); }
  };
  row.appendChild(u);
  return row;
}

// ---------- 语音 ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { rec: null, finalText: '', interim: '', submitted: false };

function openVoice() {
  if (!Recognition) { alert('这个浏览器不支持语音识别，请用 Chrome，或用输入法的麦克风'); return; }
  $('voice').classList.remove('hidden');
  listen();
}

function closeVoice() {
  $('voice').classList.add('hidden');
  if (voice.rec) { voice.rec.onend = null; voice.rec.abort(); voice.rec = null; }
  $('orb').classList.remove('live');
}

function setTranscript(text, placeholder) {
  const t = $('transcript');
  t.textContent = text;
  t.classList.toggle('placeholder', !!placeholder);
}

function listen() {
  if (voice.rec) { voice.rec.onend = null; voice.rec.abort(); }
  Object.assign(voice, { finalText: '', interim: '', submitted: false });
  setTranscript('请说话…', true);
  $('voiceHint').textContent = '说完会自动创建';

  const rec = new Recognition();
  rec.lang = state.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => $('orb').classList.add('live');
  rec.onresult = (e) => {
    let fin = '', mid = '';
    for (const r of e.results) (r.isFinal ? (fin += r[0].transcript) : (mid += r[0].transcript));
    voice.finalText = fin; voice.interim = mid;
    setTranscript(fin + mid, false);
  };
  rec.onerror = (e) => {
    $('orb').classList.remove('live');
    const msgs = {
      'not-allowed': '没有麦克风权限：请在浏览器设置里允许，或点上面的麦克风重试',
      'no-speech': '没听到声音，点麦克风再说一次',
      'network': '语音识别需要联网',
      'audio-capture': '找不到麦克风',
    };
    if (e.error !== 'aborted') $('voiceHint').textContent = msgs[e.error] || ('识别出错：' + e.error);
  };
  rec.onend = () => {
    $('orb').classList.remove('live');
    voice.rec = null;
    finishVoice();
  };
  voice.rec = rec;
  try { rec.start(); } catch (e) { $('voiceHint').textContent = '点上面的麦克风开始说话'; }
}

function finishVoice() {
  const text = (voice.finalText || voice.interim).trim();
  if (!text || voice.submitted) return;
  voice.submitted = true;
  input.value = text;
  closeVoice();
  submit(text);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('fab').onclick = openVoice;
$('orb').onclick = listen;
$('voiceCancel').onclick = closeVoice;
$('voiceDone').onclick = () => { if (voice.rec) voice.rec.stop(); else finishVoice(); };
$('voice').addEventListener('click', (e) => { if (e.target === $('voice')) closeVoice(); });

// ---------- 月历 ----------

function gridStart() {
  const first = new Date(state.year, state.month, 1);
  return addDays(first, -((first.getDay() + 6) % 7));   // 周一开头
}

async function load() {
  $('grid').classList.add('loading');
  const start = gridStart();
  const want = state.year + '-' + state.month;
  try {
    const data = await api('getRange', keyOf(start), keyOf(addDays(start, 42)));
    if (want !== state.year + '-' + state.month) return;   // 期间已翻到别的月
    setData(data);
    store.set('cache', JSON.stringify({ month: want, data }));
  } catch (e) {
    handleError(e, $('dayList'));
  } finally {
    $('grid').classList.remove('loading');
  }
}

function setData(data) {
  state.data = data;
  state.categories = data.categories;
  if (!state.selected) state.selected = data.today;
  render();
}

/** 'yyyy-MM-dd' → 当天的日程和到期待办 */
function indexByDay() {
  const map = {};
  const add = (k, x) => (map[k] = map[k] || []).push(x);
  state.data.events.filter(visible).forEach((e) => {
    let d = fromKey(e.startKey);
    const end = fromKey(e.endKey);
    for (let i = 0; d <= end && i < 62; i++, d = addDays(d, 1)) add(keyOf(d), { kind: 'event', ...e });
  });
  state.data.tasks.filter(visible).forEach((t) => { if (t.dueKey) add(t.dueKey, { kind: 'task', ...t }); });
  return map;
}

function render() {
  renderLegend();
  renderGrid();
  renderDay();
  renderTasks();
}

function renderLegend() {
  const box = $('legend'); box.innerHTML = '';
  state.categories.concat([OTHER]).forEach((c) => {
    const chip = el('span', 'chip' + (state.hidden.has(c.name) ? ' off' : ''));
    const d = el('span', 'dot'); d.style.background = c.color;
    chip.appendChild(d); chip.appendChild(document.createTextNode(c.name));
    chip.onclick = () => {
      state.hidden.has(c.name) ? state.hidden.delete(c.name) : state.hidden.add(c.name);
      render();
    };
    box.appendChild(chip);
  });
}

function renderGrid() {
  $('monthLabel').textContent = state.year + '年' + (state.month + 1) + '月';
  const grid = $('grid'); grid.innerHTML = '';
  ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => grid.appendChild(el('div', 'wd', w)));
  const byDay = indexByDay();
  const maxShow = window.matchMedia('(max-width: 600px)').matches ? 3 : 4;
  let d = gridStart();
  for (let i = 0; i < 42; i++, d = addDays(d, 1)) {
    const k = keyOf(d);
    const cls = ['cell'];
    if (d.getMonth() !== state.month) cls.push('out');
    if (k === state.data.today) cls.push('today');
    if (k === state.selected) cls.push('sel');
    const cell = el('div', cls.join(' '));
    cell.appendChild(el('div', 'num', d.getDate()));
    const list = byDay[k] || [];
    list.slice(0, list.length > maxShow ? maxShow - 1 : maxShow).forEach((x) => cell.appendChild(pill(x)));
    if (list.length > maxShow) cell.appendChild(el('div', 'more', '+' + (list.length - maxShow + 1)));
    cell.onclick = () => { state.selected = k; renderGrid(); renderDay(); };
    grid.appendChild(cell);
  }
}

function pill(x) {
  const p = el('div', 'ev');
  if (x.kind === 'event' && x.allDay) {
    p.classList.add('fill'); p.style.background = x.color; p.textContent = x.title;
  } else if (x.kind === 'event') {
    // 定时日程：浅色底 + 分类色左边框，和全天日程区分
    p.style.background = x.color + '22'; p.style.borderLeft = '3px solid ' + x.color;
    p.appendChild(el('span', 't', x.time));
    p.appendChild(document.createTextNode(x.title));
  } else {
    p.style.border = '1px solid ' + x.color;
    p.textContent = '☐ ' + x.title;
  }
  return p;
}

function renderDay() {
  const k = state.selected;
  $('dayTitle').textContent = (k === state.data.today ? '今天 · ' : '') + dayLabel(k);
  const box = $('dayList'); box.innerHTML = '';
  const list = indexByDay()[k] || [];
  if (!list.length) { box.appendChild(el('div', 'empty', '这天没有安排')); return; }
  list.forEach((x) => box.appendChild(x.kind === 'event' ? eventRow(x, k) : taskRow(x)));
}

function eventRow(e, k) {
  const row = el('div', 'item');
  const bar = el('div', 'bar'); bar.style.background = e.color;
  row.appendChild(bar);
  let when = '全天';
  if (!e.allDay) when = (e.startKey === k ? e.time : '00:00') + '–' + (e.endKey === k ? e.endTime : '');
  row.appendChild(el('div', 'when', when));
  const body = el('div', 'body');
  body.appendChild(el('div', 'title', e.title));
  const meta = el('div', 'meta');
  meta.appendChild(tag(e.category, e.color));
  meta.appendChild(document.createTextNode([e.category === '其他' ? e.calName : '', e.location].filter(Boolean).join(' · ')));
  body.appendChild(meta);
  row.appendChild(body);
  const a = el('a', 'ghost', '查看');
  a.href = e.link; a.target = '_blank'; a.rel = 'noopener';
  row.appendChild(a);
  return row;
}

function taskRow(t) {
  const row = el('label', 'item');
  const cb = el('input'); cb.type = 'checkbox';
  cb.onchange = async () => {
    cb.disabled = true;
    try {
      await api('completeTask', t.listId, t.id);
      row.style.opacity = .4; row.style.textDecoration = 'line-through';
      load();
    } catch (e) { cb.checked = false; cb.disabled = false; handleError(e); }
  };
  row.appendChild(cb);
  const body = el('div', 'body');
  body.appendChild(el('div', 'title', t.title));
  const meta = el('div', 'meta');
  meta.appendChild(tag(t.category, t.color));
  if (t.due) meta.appendChild(el('span', t.overdue ? 'err' : '', (t.overdue ? '已过期 · ' : '截止 ') + t.due));
  body.appendChild(meta);
  row.appendChild(body);
  return row;
}

function renderTasks() {
  const box = $('tasks'); box.innerHTML = '';
  const tasks = state.data.tasks.filter(visible);
  if (!tasks.length) { box.appendChild(el('div', 'empty', '没有待办 🎉')); return; }
  tasks.forEach((t) => box.appendChild(taskRow(t)));
}

function shiftMonth(n) {
  const d = new Date(state.year, state.month + n, 1);
  state.year = d.getFullYear(); state.month = d.getMonth();
  state.selected = keyOf(d);
  $('monthLabel').textContent = state.year + '年' + (state.month + 1) + '月';
  load();
}

$('prev').onclick = () => shiftMonth(-1);
$('next').onclick = () => shiftMonth(1);
$('todayBtn').onclick = () => {
  const now = new Date();
  state.year = now.getFullYear(); state.month = now.getMonth();
  state.selected = state.data ? state.data.today : keyOf(now);
  load();
};
send.onclick = () => submit();
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
});
window.addEventListener('resize', () => { if (state.data) renderGrid(); });

// ---------- 启动 ----------

function start() {
  showApp();
  buildCategorySeg();
  // 先用上次的数据秒开，再去后台刷新
  try {
    const c = JSON.parse(store.get('cache') || 'null');
    if (c && c.month === state.year + '-' + state.month) setData(c.data);
  } catch (e) { /* 缓存坏了就忽略 */ }
  load();
  // 从桌面「语音新建」快捷方式进来时直接开始听
  if (new URLSearchParams(location.search).get('voice') === '1') {
    history.replaceState(null, '', location.pathname);
    openVoice();
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (state.token) start(); else showGate();
