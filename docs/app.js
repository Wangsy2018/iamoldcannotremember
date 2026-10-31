// AI 日程 · 网页 App。后台是 Google Apps Script（apps-script/Code.gs），这里只负责界面。
const API = 'https://script.google.com/macros/s/AKfycbwEtT_UYhShFJcmSjEg-0163SekKB2sU7acnqHLY27gqf4QM2PCGMBhX1zHVaWTVldJZw/exec';

// 深色背景下用更亮的分类色；后台给的颜色只在未知分类时兜底
const NEON = { '日常': '#34d399', '工作': '#60a5fa', '重要': '#fb7185', '其他': '#94a3b8' };
const CATS = ['日常', '工作', '重要'];
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
  view: store.get('view') || 'today',
  year: new Date().getFullYear(),
  month: new Date().getMonth(),   // 0-11，日历页正在看的月份
  selected: null,                 // 日历页选中的 'yyyy-MM-dd'
  category: '',                   // 创建时指定分类，'' = AI 自动判断
  hidden: new Set(),              // 日历页筛掉的分类
  todayData: null,                // 今天起 8 天，给「今天」和「待办」页用
  monthData: null,                // 日历页当前月
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
const hue = (x) => NEON[x.category] || x.color || NEON['其他'];

/** 把日程（可能跨多天）和有截止日的待办摊到每一天 */
function indexByDay(data, filter) {
  const map = {};
  const add = (k, x) => (map[k] = map[k] || []).push(x);
  data.events.filter(filter).forEach((e) => {
    let d = fromKey(e.startKey);
    const end = fromKey(e.endKey);
    for (let i = 0; d <= end && i < 62; i++, d = addDays(d, 1)) add(keyOf(d), { kind: 'event', ...e });
  });
  data.tasks.filter(filter).forEach((t) => { if (t.dueKey) add(t.dueKey, { kind: 'task', ...t }); });
  return map;
}

// ---------- 登录 ----------

function showGate(msg) {
  $('app').classList.add('hidden');
  $('tabbar').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('gateMsg').textContent = msg || '';
  $('tokenInput').focus();
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

$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('logout').onclick = () => { if (confirm('在这台设备上退出？需要重新输入密码才能再进来。')) logout(); };

// ---------- 底部导航 ----------

function showView(v) {
  state.view = v;
  store.set('view', v);
  ['today', 'cal', 'tasks'].forEach((n) => $('view-' + n).classList.toggle('hidden', n !== v));
  [...$('tabbar').children].forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  window.scrollTo({ top: 0 });
  if (v === 'cal' && !state.monthData) loadMonth();
}
[...$('tabbar').children].forEach((b) => { b.onclick = () => showView(b.dataset.view); });

// ---------- 输入区 ----------

function buildCategorySeg() {
  const seg = $('catSeg'); seg.innerHTML = '';
  [['', '自动']].concat(CATS.map((c) => [c, c])).forEach(([val, label]) => {
    const b = el('button', val === state.category ? 'on' : '');
    if (val) { const d = el('span', 'dot'); d.style.background = NEON[val]; d.style.color = NEON[val]; b.appendChild(d); }
    b.appendChild(document.createTextNode(label));
    b.onclick = () => {
      state.category = val;
      [...seg.children].forEach((x) => x.classList.toggle('on', x === b));
    };
    seg.appendChild(b);
  });
}

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  send.disabled = true; send.textContent = 'AI 识别中…';
  const box = $('result'); box.innerHTML = '';
  try {
    const items = await api('processInput', text, state.category);
    const card = el('div', 'card');
    items.forEach((r) => card.appendChild(resultRow(r)));
    box.appendChild(card);
    if (items.some((r) => r.ok)) input.value = '';
    refresh();
  } catch (e) {
    if (e.auth) return handleError(e);
    box.appendChild(el('div', 'card err', '出错了：' + (e.message || e)));
  } finally {
    send.disabled = false; send.textContent = '创建';
  }
}

function tag(category) {
  const t = el('span', 'tag', category);
  t.style.color = NEON[category] || NEON['其他'];
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
  title.appendChild(tag(r.category));
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
      refresh();
    } catch (e) { u.disabled = false; handleError(e); }
  };
  row.appendChild(u);
  return row;
}

// ---------- 今天页 ----------

async function loadToday() {
  const today = new Date();
  try {
    const data = await api('getRange', keyOf(today), keyOf(addDays(today, 8)));
    state.todayData = data;
    store.set('cache', JSON.stringify(data));
    renderToday();
    renderTasks();
  } catch (e) {
    handleError(e, $('todayList'));
  }
}

function renderHeader() {
  const now = new Date();
  const k = state.todayData ? state.todayData.today : keyOf(now);
  const d = fromKey(k);
  const dl = $('dateLine'); dl.innerHTML = '';
  dl.appendChild(document.createTextNode((d.getMonth() + 1) + '月' + d.getDate() + '日'));
  dl.appendChild(el('span', 'wk', WD[d.getDay()]));

  const h = now.getHours();
  const hello = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const g = $('greet'); g.innerHTML = '';
  if (!state.todayData) { g.textContent = hello; return; }
  const n = (indexByDay(state.todayData, () => true)[k] || []).length;
  g.appendChild(document.createTextNode(hello + ' · '));
  if (n) {
    g.appendChild(document.createTextNode('今天有 '));
    g.appendChild(el('b', '', String(n)));
    g.appendChild(document.createTextNode(' 件事'));
  } else {
    g.appendChild(document.createTextNode('今天没有安排'));
  }
}

function renderToday() {
  renderHeader();
  const data = state.todayData;
  const byDay = indexByDay(data, () => true);
  const k = data.today;

  const week = Object.keys(byDay).filter((d) => d >= k).reduce((s, d) => s + byDay[d].length, 0);
  const overdue = data.tasks.filter((t) => t.overdue).length;
  const stats = $('stats'); stats.innerHTML = '';
  [[(byDay[k] || []).length, '今日安排'], [week, '未来 7 天'], [data.tasks.length, overdue ? '待办 · ' + overdue + ' 过期' : '未完成待办']]
    .forEach(([n, l]) => {
      const s = el('div', 'stat');
      s.appendChild(el('div', 'n', String(n)));
      s.appendChild(el('div', 'l', l));
      stats.appendChild(s);
    });

  const tl = $('todayList'); tl.innerHTML = '';
  const list = byDay[k] || [];
  if (!list.length) tl.appendChild(el('div', 'empty', '今天很空闲 ✨'));
  list.forEach((x) => tl.appendChild(x.kind === 'event' ? eventRow(x, k) : taskRow(x)));

  const up = $('upcoming'); up.innerHTML = '';
  let any = false;
  for (let i = 1; i <= 7; i++) {
    const dk = keyOf(addDays(fromKey(k), i));
    const items = byDay[dk] || [];
    if (!items.length) continue;
    any = true;
    up.appendChild(el('div', 'upday', (i === 1 ? '明天 · ' : i === 2 ? '后天 · ' : '') + dayLabel(dk)));
    items.forEach((x) => up.appendChild(x.kind === 'event' ? eventRow(x, dk) : taskRow(x)));
  }
  if (!any) up.appendChild(el('div', 'empty', '未来一周没有安排'));
}

function eventRow(e, k) {
  const row = el('div', 'item');
  const node = el('div', 'node'); node.style.color = hue(e);
  row.appendChild(node);
  const when = el('div', 'when');
  if (e.allDay) when.appendChild(el('b', '', '全天'));
  else {
    when.appendChild(el('b', '', e.startKey === k ? e.time : '00:00'));
    when.appendChild(document.createTextNode(e.endKey === k ? e.endTime : '跨天'));
  }
  row.appendChild(when);
  const body = el('div', 'body');
  body.appendChild(el('div', 'title', e.title));
  const meta = el('div', 'meta');
  meta.appendChild(tag(e.category));
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
      refresh();
    } catch (e) { cb.checked = false; cb.disabled = false; handleError(e); }
  };
  row.appendChild(cb);
  const body = el('div', 'body');
  body.appendChild(el('div', 'title', t.title));
  const meta = el('div', 'meta');
  meta.appendChild(tag(t.category));
  if (t.due) meta.appendChild(el('span', t.overdue ? 'err' : '', (t.overdue ? '已过期 · ' : '截止 ') + t.due));
  body.appendChild(meta);
  row.appendChild(body);
  return row;
}

// ---------- 待办页 ----------

function renderTasks() {
  const box = $('tasks'); box.innerHTML = '';
  const tasks = state.todayData.tasks;
  if (!tasks.length) { box.appendChild(el('div', 'empty', '没有待办 🎉')); return; }
  tasks.forEach((t) => box.appendChild(taskRow(t)));
}

// ---------- 日历页 ----------

function gridStart() {
  const first = new Date(state.year, state.month, 1);
  return addDays(first, -((first.getDay() + 6) % 7));   // 周一开头
}

async function loadMonth() {
  $('grid').classList.add('loading');
  $('monthLabel').textContent = state.year + '年' + (state.month + 1) + '月';
  const start = gridStart();
  const want = state.year + '-' + state.month;
  try {
    const data = await api('getRange', keyOf(start), keyOf(addDays(start, 42)));
    if (want !== state.year + '-' + state.month) return;   // 期间已翻到别的月
    state.monthData = data;
    if (!state.selected) state.selected = data.today;
    renderCalendar();
  } catch (e) {
    handleError(e, $('dayList'));
  } finally {
    $('grid').classList.remove('loading');
  }
}

const calVisible = (x) => !state.hidden.has(x.category);

function renderCalendar() {
  renderLegend();
  renderGrid();
  renderDay();
}

function renderLegend() {
  const box = $('legend'); box.innerHTML = '';
  CATS.concat(['其他']).forEach((c) => {
    const chip = el('span', 'chip' + (state.hidden.has(c) ? ' off' : ''));
    const d = el('span', 'dot'); d.style.background = NEON[c]; d.style.color = NEON[c];
    chip.appendChild(d); chip.appendChild(document.createTextNode(c));
    chip.onclick = () => {
      state.hidden.has(c) ? state.hidden.delete(c) : state.hidden.add(c);
      renderCalendar();
    };
    box.appendChild(chip);
  });
}

function renderGrid() {
  $('monthLabel').textContent = state.year + '年' + (state.month + 1) + '月';
  const grid = $('grid'); grid.innerHTML = '';
  ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => grid.appendChild(el('div', 'wd', w)));
  const data = state.monthData;
  const byDay = indexByDay(data, calVisible);
  const maxShow = window.matchMedia('(max-width: 600px)').matches ? 3 : 4;
  let d = gridStart();
  for (let i = 0; i < 42; i++, d = addDays(d, 1)) {
    const k = keyOf(d);
    const cls = ['cell'];
    if (d.getMonth() !== state.month) cls.push('out');
    if (k === data.today) cls.push('today');
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
  const c = hue(x);
  if (x.kind === 'event' && x.allDay) {
    p.style.background = c + '55'; p.style.color = '#fff'; p.textContent = x.title;
  } else if (x.kind === 'event') {
    p.style.background = c + '22'; p.style.color = c; p.style.borderLeft = '2px solid ' + c;
    p.appendChild(el('span', 't', x.time));
    p.appendChild(document.createTextNode(x.title));
  } else {
    p.style.border = '1px solid ' + c + '99'; p.style.color = c;
    p.textContent = '☐ ' + x.title;
  }
  return p;
}

function renderDay() {
  const k = state.selected;
  $('dayTitle').textContent = (k === state.monthData.today ? '今天 · ' : '') + dayLabel(k);
  const box = $('dayList'); box.innerHTML = '';
  const list = indexByDay(state.monthData, calVisible)[k] || [];
  if (!list.length) { box.appendChild(el('div', 'empty', '这天没有安排')); return; }
  list.forEach((x) => box.appendChild(x.kind === 'event' ? eventRow(x, k) : taskRow(x)));
}

function shiftMonth(n) {
  const d = new Date(state.year, state.month + n, 1);
  state.year = d.getFullYear(); state.month = d.getMonth();
  state.selected = keyOf(d);
  loadMonth();
}

$('prev').onclick = () => shiftMonth(-1);
$('next').onclick = () => shiftMonth(1);
$('todayBtn').onclick = () => {
  const now = new Date();
  state.year = now.getFullYear(); state.month = now.getMonth();
  state.selected = keyOf(now);
  loadMonth();
};
send.onclick = submit;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
});
window.addEventListener('resize', () => { if (state.monthData) renderGrid(); });

// ---------- 启动 ----------

/** 新建、撤销、勾掉待办之后，两边的数据都要刷新 */
function refresh() {
  loadToday();
  if (state.monthData) loadMonth();
}

function start() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('tabbar').classList.remove('hidden');
  buildCategorySeg();
  renderHeader();
  // 先用上次的数据秒开，再去后台刷新
  try {
    const c = JSON.parse(store.get('cache') || 'null');
    if (c && c.events && c.today === keyOf(new Date())) { state.todayData = c; renderToday(); renderTasks(); }
  } catch (e) { /* 缓存坏了就忽略 */ }
  showView(state.view);
  loadToday();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (state.token) start(); else showGate();
