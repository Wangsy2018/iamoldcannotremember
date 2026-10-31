/**
 * AI 日程助手：一句话 → Google 日历事件 / Google Tasks 待办，按「日常 / 工作 / 重要」分类。
 * 每个分类对应一个同名 Google 日历和一个同名待办清单，第一次用到时自动创建。
 *
 * 前端是 GitHub Pages 上的网页 App，通过 doPost 调用这里，靠 APP_TOKEN 校验身份。
 *
 * 脚本属性（项目设置 → 脚本属性）：
 *   DEEPSEEK_API_KEY  必填
 *   DEEPSEEK_MODEL    可选，默认 deepseek-chat
 *   APP_TOKEN         App 的访问密码，在编辑器里运行 setupToken 自动生成
 */

const CATEGORIES = {
  '日常': { color: '#16a765' },
  '工作': { color: '#4986e7' },
  '重要': { color: '#f83a22' },
};
const CATEGORY_NAMES = Object.keys(CATEGORIES);
const OTHER = '其他';
// Zoom / Teams / Meet / Webex 会议链接
const MEETING_URL_RE = /https?:\/\/[^\s<>"']*(?:zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com)[^\s<>"']*/gi;
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const D_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// 部署对所有人开放，所以这里不返回任何页面；除 doGet/doPost/setupToken 外的函数都以 _ 结尾，外部调不到
function doGet() {
  return ContentService.createTextOutput('AI 日程后台运行中');
}

/** 请求体（text/plain，避免跨域预检）：{"token": "...", "action": "getRange", "args": [...]} */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '请求格式不对' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!token || String(body.token || '').replace(/[^a-z0-9]/gi, '').toLowerCase() !== token) {
    return json_({ ok: false, auth: false, error: '密码不对' });
  }
  const fn = API_[body.action];
  if (!fn) return json_({ ok: false, error: '未知操作：' + body.action });
  try {
    return json_({ ok: true, data: fn.apply(null, body.args || []) });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

const API_ = {
  ping: function () { return true; },
  processInput: processInput_,
  processImage: processImage_,
  undo: undo_,
  completeTask: completeTask_,
  getRange: getRange_,
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 在编辑器里运行一次：生成 App 密码（已有则不变），在执行日志里显示 */
function setupToken() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('APP_TOKEN');
  if (!token) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';  // 去掉 i l o 0 1 等易混字符
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + Date.now());
    token = bytes.slice(0, 20).map(function (b) { return alphabet[(b + 128) % alphabet.length]; }).join('');
    props.setProperty('APP_TOKEN', token);
  }
  console.log('App 密码：' + token.match(/.{1,4}/g).join('-'));
}

// ---------- 时间工具 ----------

function tz_() { return Session.getScriptTimeZone(); }
function fmt_(date, pattern) { return Utilities.formatDate(date, tz_(), pattern); }
function weekday_(date) { return WEEKDAY[fmt_(date, 'EEE')] || ''; }
function parseLocal_(s) { return Utilities.parseDate(s, tz_(), "yyyy-MM-dd'T'HH:mm"); }
function parseDay_(s) { return Utilities.parseDate(s, tz_(), 'yyyy-MM-dd'); }
function dayLabel_(date) { return fmt_(date, 'M/d') + ' ' + weekday_(date); }

// ---------- 分类对应的日历 / 待办清单 ----------

function calendarList_() {
  return Calendar.CalendarList.list({ maxResults: 250 }).items || [];
}

/** 分类名 → 日历 id；缺的日历会新建并上色 */
function categoryCalendar_(name) {
  const found = calendarList_().find(function (c) { return c.summary === name && c.accessRole === 'owner'; });
  if (found) return found.id;
  const cal = Calendar.Calendars.insert({ summary: name, timeZone: tz_() });
  Calendar.CalendarList.patch(
    { backgroundColor: CATEGORIES[name].color, foregroundColor: '#ffffff' },
    cal.id, { colorRgbFormat: true });
  return cal.id;
}

function taskLists_() {
  return Tasks.Tasklists.list({ maxResults: 100 }).items || [];
}

/** 分类名 → 待办清单 id；缺的清单会新建 */
function categoryTasklist_(name) {
  const found = taskLists_().find(function (l) { return l.title === name; });
  return found ? found.id : Tasks.Tasklists.insert({ title: name }).id;
}

function pickCategory_(forced, guessed) {
  if (CATEGORIES[forced]) return forced;
  if (CATEGORIES[guessed]) return guessed;
  return '日常';
}

// ---------- DeepSeek ----------

function systemPrompt_(now) {
  // 给模型一张日期对照表，避免它自己推算“下周三”是几号时算错
  const marks = ['（今天）', '（明天）', '（后天）'];
  const table = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(now.getTime() + i * DAY);
    table.push(fmt_(d, 'yyyy-MM-dd') + ' ' + weekday_(d) + (marks[i] || ''));
  }
  return [
    '你是日程助手，把用户的话解析成日历事件或待办，只输出 JSON。',
    '当前时间：' + fmt_(now, 'yyyy-MM-dd HH:mm') + ' ' + weekday_(now) + '（时区 ' + tz_() + '）',
    '未来三周日期对照（星期直接查表，不要自己推算）：',
    table.join('\n'),
    '',
    '规则：',
    '1. 有具体时刻、或用户要求“提醒” → type "event"。只是要做的事、没有具体时刻 → type "task"，有截止日期就填 due。',
    '2. 时间用 24 小时制本地时间 "YYYY-MM-DDTHH:mm"。只说“早上”取 09:00，“中午”12:00，“下午”15:00，“晚上”20:00。',
    '3. 只有日期没有时刻、但要求提醒 → event，时间取当天 09:00。用户明确说“全天/一整天” → all_day 为 true，填 date。',
    '4. 没说日期且该时刻今天已过 → 取明天。',
    '5. “这周X/本周X”指本周（周一到周日）；“下周X”指下一个周一开始那一周的周X。',
    '6. 没说结束时间 → end 为 start 后 1 小时。',
    '7. reminders 是“提前多少分钟提醒”的数组：“提前半小时”→[30]，“提前一天”→[1440]，“到时候提醒我/提醒我”没说提前多久→[0]。完全没提提醒→null（用日历默认）。',
    '8. 重复（每天/每周一/每月1号…）→ recurrence 填 RRULE，如 "RRULE:FREQ=WEEKLY;BYDAY=MO"；不重复填 null。',
    '9. 一句话里有多件事就输出多条。',
    '10. title 简短、不含时间词，如“和王总开会”。地点填 location，其他补充信息填 notes。',
    '11. category 必填，三选一：',
    '   "工作"：上班相关，如会议、客户、项目、报告、出差、加班；',
    '   "重要"：错过会有严重后果的事，如考试、面试、证件办理、看病、航班、缴费截止、生日纪念日，或用户说了“重要/别忘了/一定要”；',
    '   "日常"：其余生活琐事，如买菜、运动、打电话、聚餐。',
    '12. 无法理解 → items 为空数组，error 用一句中文说明原因。',
    '',
    '输出格式示例：',
    '{"items":[',
    '{"type":"event","category":"工作","title":"和王总开会","start":"2026-01-07T15:00","end":"2026-01-07T16:00","all_day":false,"date":null,"reminders":[30],"recurrence":null,"location":null,"notes":null},',
    '{"type":"task","category":"日常","title":"买牛奶","due":"2026-01-09","notes":null}',
    '],"error":null}',
  ].join('\n');
}

/** extraRules：追加在系统提示后面的补充规则（比如截图识别时的邮件规则） */
function callDeepSeek_(text, extraRules) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('DEEPSEEK_API_KEY');
  if (!key) throw new Error('还没设置 DEEPSEEK_API_KEY：项目设置 → 脚本属性里添加');

  const resp = UrlFetchApp.fetch('https://api.deepseek.com/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: props.getProperty('DEEPSEEK_MODEL') || 'deepseek-chat',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt_(new Date()) + (extraRules ? '\n\n' + extraRules : '') },
        { role: 'user', content: text },
      ],
    }),
  });
  const code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('DeepSeek 返回 ' + code + '：' + resp.getContentText().slice(0, 200));
  }
  const content = JSON.parse(resp.getContentText()).choices[0].message.content;
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('AI 返回的不是合法 JSON：' + content.slice(0, 200));
  }
}

// ---------- 网页调用的接口 ----------

/**
 * 解析一句话并创建。forcedCategory 为空表示让 AI 判断分类。
 * 逐条返回结果，某条失败不影响其他条。
 */
function processInput_(text, forcedCategory) {
  text = String(text || '').trim();
  if (!text) throw new Error('请输入内容');
  return createAll_(callDeepSeek_(text), forcedCategory);
}

/**
 * 会议邮件截图 → 文字识别（借 Google 云端硬盘的 OCR，临时文件用完即删）→ AI 解析 → 创建。
 * 返回识别出的原文，方便核对。
 */
function processImage_(b64, mime, forcedCategory) {
  if (!b64) throw new Error('没收到图片');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime || 'image/jpeg', 'meeting.jpg');
  const text = ocr_(blob).trim();
  if (!text) throw new Error('图片里没识别出文字');
  const parsed = callDeepSeek_(text.slice(0, 12000), emailRules_());
  fixMeetingLinks_(parsed.items, text);
  return { text: text, results: createAll_(parsed, forcedCategory) };
}

function ocr_(blob) {
  const file = Drive.Files.create(
    { name: 'AI日程-临时文字识别', mimeType: 'application/vnd.google-apps.document' }, blob, { fields: 'id' });
  try {
    return UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.id + '/export?mimeType=text/plain', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    }).getContentText();
  } finally {
    Drive.Files.remove(file.id);
  }
}

function emailRules_() {
  return [
    '补充：用户发来的是会议邀请邮件截图经 OCR 识别出的文字，可能有错字和断行。',
    'a. 只提取会议或活动本身，忽略签名、免责声明、引用的旧邮件里的时间。',
    'b. 邮件写明了其他时区（如 EST、GMT+1、UTC-05:00）→ 换算成 ' + tz_() + ' 本地时间，并在 notes 里写上原文时间。',
    'c. 会议链接（Zoom、Teams、Google Meet、Webex 等）原样填进 location，一个字符都不要改；会议号、密码写进 notes。',
    'd. 邮件没提提醒 → reminders 取 [15]。',
    'e. 没写结束时间但写了时长 → 按时长算 end。',
  ].join('\n');
}

/**
 * AI 可能改坏或漏掉会议链接：以 OCR 原文里的链接为准，并把链接写进备注。
 * 链接放在 location，手机日历的提醒通知里会显示出来。
 */
function fixMeetingLinks_(items, text) {
  const found = text.match(MEETING_URL_RE) || [];
  if (!found.length || !Array.isArray(items)) return;
  const compact = text.replace(/\s+/g, '');
  items.forEach(function (it) {
    if (it.type === 'task') return;
    const loc = String(it.location || '');
    const m = loc.match(MEETING_URL_RE);
    let url;
    if (m && compact.indexOf(m[0]) !== -1) url = m[0];
    else if (m) { url = found[0]; it.location = loc.replace(m[0], url); }
    else { url = found[0]; it.location = loc ? url + ' ' + loc : url; }
    const notes = String(it.notes || '');
    if (notes.indexOf(url) === -1) it.notes = (notes ? notes + '\n' : '') + '会议链接：' + url;
  });
}

function meetingLink_(s) {
  const m = String(s || '').replace(/&amp;/g, '&').match(MEETING_URL_RE);
  return m ? m[0] : '';
}

/** 逐条创建，某条失败不影响其他条 */
function createAll_(parsed, forcedCategory) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  if (!items.length) throw new Error(parsed.error || '没识别出日程或待办，换个说法试试');

  return items.map(function (it) {
    try {
      const cat = pickCategory_(forcedCategory, it.category);
      return it.type === 'task' ? createTask_(it, cat) : createEvent_(it, cat);
    } catch (e) {
      return { ok: false, title: it.title || '', error: e.message };
    }
  });
}

/** container 是日历 id（日程）或清单 id（待办） */
function undo_(kind, container, id) {
  if (kind === 'event') Calendar.Events.remove(container, id);
  else Tasks.Tasks.remove(container, id);
  return true;
}

function completeTask_(listId, id) {
  Tasks.Tasks.patch({ status: 'completed' }, listId, id);
  return true;
}

/** 取 [startKey, endKey) 之间所有可见日历的日程，以及全部未完成待办 */
function getRange_(startKey, endKey) {
  const timeMin = parseDay_(startKey).toISOString();
  const timeMax = parseDay_(endKey).toISOString();
  const cals = calendarList_().filter(function (c) { return c.selected || c.primary; });

  const events = [];
  cals.forEach(function (c) {
    const cat = CATEGORIES[c.summary] && c.accessRole === 'owner' ? c.summary : OTHER;
    const items = Calendar.Events.list(c.id, {
      timeMin: timeMin, timeMax: timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 250,
    }).items || [];
    items.forEach(function (e) {
      if (e.status === 'cancelled' || !e.start) return;
      const allDay = !e.start.dateTime;
      const start = allDay ? parseDay_(e.start.date) : new Date(e.start.dateTime);
      const end = allDay ? parseDay_(e.end.date) : new Date(e.end.dateTime);
      // 结束日（含）：全天事件的 end 是次日 0 点，定时事件 0 点整结束也算前一天
      const last = new Date(Math.max(start.getTime(), end.getTime() - 1));
      events.push({
        id: e.id,
        calId: c.id,
        title: e.summary || '（无标题）',
        startKey: fmt_(start, 'yyyy-MM-dd'),
        endKey: fmt_(last, 'yyyy-MM-dd'),
        allDay: allDay,
        time: allDay ? '' : fmt_(start, 'HH:mm'),
        endTime: allDay ? '' : fmt_(end, 'HH:mm'),
        sort: start.getTime(),
        category: cat,
        calName: c.summaryOverride || c.summary,
        // 非分类日历统一用灰色，免得和分类色撞色
        color: cat === OTHER ? '#8e8e93' : CATEGORIES[cat].color,
        location: e.location || '',
        meetLink: e.hangoutLink || meetingLink_(e.location) || meetingLink_(e.description),
        link: e.htmlLink,
      });
    });
  });
  events.sort(function (a, b) { return a.sort - b.sort; });

  return {
    today: fmt_(new Date(), 'yyyy-MM-dd'),
    categories: CATEGORY_NAMES.map(function (n) { return { name: n, color: CATEGORIES[n].color }; }),
    events: events,
    tasks: listTasks_(),
  };
}

function listTasks_() {
  const today = fmt_(new Date(), 'yyyy-MM-dd');
  const out = [];
  taskLists_().forEach(function (l) {
    const cat = CATEGORIES[l.title] ? l.title : OTHER;
    (Tasks.Tasks.list(l.id, { showCompleted: false, maxResults: 100 }).items || []).forEach(function (t) {
      if (!t.title) return;
      const due = t.due ? t.due.slice(0, 10) : null;  // Tasks 的 due 只有日期有意义
      out.push({
        id: t.id,
        listId: l.id,
        title: t.title,
        category: cat,
        color: cat === OTHER ? '#8e8e93' : CATEGORIES[cat].color,
        dueKey: due,
        due: due ? dayLabel_(parseDay_(due)) : null,
        overdue: !!due && due < today,
      });
    });
  });
  return out.sort(function (a, b) { return (a.dueKey || '9999') < (b.dueKey || '9999') ? -1 : 1; });
}

// ---------- 创建 ----------

function createEvent_(it, cat) {
  const title = requireTitle_(it.title);
  const tz = tz_();
  const ev = { summary: title };
  if (it.location) ev.location = String(it.location);
  if (it.notes) ev.description = String(it.notes);

  let when;
  if (it.all_day) {
    const date = it.date || String(it.start || '').slice(0, 10);
    if (!D_RE.test(date)) throw new Error('日期格式不对：' + date);
    const day = parseDay_(date);
    ev.start = { date: date };
    ev.end = { date: fmt_(new Date(day.getTime() + 36 * HOUR), 'yyyy-MM-dd') };  // 结束日不含当天
    when = dayLabel_(day) + ' 全天';
  } else {
    if (!DT_RE.test(it.start || '')) throw new Error('时间格式不对：' + it.start);
    const start = parseLocal_(it.start);
    let end = DT_RE.test(it.end || '') ? parseLocal_(it.end) : null;
    if (!end || end <= start) end = new Date(start.getTime() + HOUR);
    ev.start = { dateTime: fmt_(start, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: tz };
    ev.end = { dateTime: fmt_(end, "yyyy-MM-dd'T'HH:mm:ss"), timeZone: tz };
    const sameDay = fmt_(start, 'yyyy-MM-dd') === fmt_(end, 'yyyy-MM-dd');
    when = dayLabel_(start) + ' ' + fmt_(start, 'HH:mm') + '–' + (sameDay ? fmt_(end, 'HH:mm') : dayLabel_(end) + ' ' + fmt_(end, 'HH:mm'));
  }

  let mins = null;
  if (Array.isArray(it.reminders)) {
    mins = it.reminders.map(Number)
      .filter(function (m) { return m >= 0 && m <= 40320; })  // Google 上限 4 周
      .map(Math.round)
      .slice(0, 5);
    ev.reminders = {
      useDefault: false,
      overrides: mins.map(function (m) { return { method: 'popup', minutes: m }; }),
    };
  }
  if (typeof it.recurrence === 'string' && it.recurrence.indexOf('RRULE:') === 0) {
    ev.recurrence = [it.recurrence];
  }

  const calId = categoryCalendar_(cat);
  const created = Calendar.Events.insert(ev, calId);
  return {
    ok: true,
    kind: 'event',
    id: created.id,
    container: calId,
    category: cat,
    color: CATEGORIES[cat].color,
    title: title,
    when: when,
    reminder: reminderText_(mins),
    repeat: ev.recurrence ? '重复' : '',
    meetLink: meetingLink_(ev.location) || meetingLink_(ev.description),
    link: created.htmlLink,
  };
}

function createTask_(it, cat) {
  const title = requireTitle_(it.title);
  const task = { title: title };
  if (it.notes) task.notes = String(it.notes);
  let when = '无截止日期';
  if (it.due && D_RE.test(it.due)) {
    task.due = it.due + 'T00:00:00.000Z';
    when = '截止 ' + dayLabel_(parseDay_(it.due));
  }
  const listId = categoryTasklist_(cat);
  const created = Tasks.Tasks.insert(task, listId);
  return {
    ok: true,
    kind: 'task',
    id: created.id,
    container: listId,
    category: cat,
    color: CATEGORIES[cat].color,
    title: title,
    when: when,
  };
}

function requireTitle_(t) {
  t = String(t || '').trim();
  if (!t) throw new Error('缺少标题');
  return t;
}

function reminderText_(mins) {
  if (mins === null) return '默认提醒';
  if (!mins.length) return '不提醒';
  return mins.map(function (m) {
    if (m === 0) return '到点提醒';
    if (m % 1440 === 0) return '提前 ' + m / 1440 + ' 天';
    if (m % 60 === 0) return '提前 ' + m / 60 + ' 小时';
    return '提前 ' + m + ' 分钟';
  }).join('、');
}
