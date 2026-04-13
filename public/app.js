/* ── State ───────────────────────────────────────────────────── */
let contacts = [];          // 联系人列表缓存
let currentContactId = null; // 当前选中的联系人 id
let isStreaming = false;     // AI 是否正在生成
let hasAiSession = false;   // 当前联系人是否有 AI session（决定追问是否可用）
let candidateOffset = 0;    // 当前会话候选编号起点（跨追问累计）

/* ── DOM refs ────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const contactList    = $('contactList');
const searchInput    = $('searchInput');
const messages       = $('messages');
const chatPlaceholder = $('chatPlaceholder');
const aiPlaceholder  = $('aiPlaceholder');
const aiBody         = $('aiBody');
const aiCurrent      = $('aiCurrent');
const aiAnalysis     = $('aiAnalysis');
const aiCandidates   = $('aiCandidates');
const aiHistory      = $('aiHistory');
const aiFollowup     = $('aiFollowup');
const followupInput  = $('followupInput');
const followupBtn    = $('followupBtn');

const headerBack    = $('headerBack');
const headerTitle   = $('headerTitle');
const mockToggle    = $('mockToggle');
const mockControls  = $('mockControls');
const mockToggleArrow = $('mockToggleArrow');
const mockName      = $('mockName');
const mockMsg       = $('mockMsg');
const mockIsSelf    = $('mockIsSelf');
const mockSend      = $('mockSend');
const mockTrigger   = $('mockTrigger');

// 联系人管理
const addContactBtn = $('addContactBtn');
const ctxMenu       = $('ctxMenu');

// 消息管理
const msgCtxMenu    = $('msgCtxMenu');
const ctxRename     = $('ctxRename');
const ctxClear      = $('ctxClear');
const ctxDelete     = $('ctxDelete');
const modalMask     = $('modalMask');
const modalTitle    = $('modalTitle');
const modalInput    = $('modalInput');
const modalCancel   = $('modalCancel');
const modalConfirm  = $('modalConfirm');
const confirmMask   = $('confirmMask');
const notesMask     = $('notesMask');
const notesInput    = $('notesInput');
const notesCancel   = $('notesCancel');
const notesSave     = $('notesSave');
const confirmTitle  = $('confirmTitle');
const confirmBody   = $('confirmBody');
const confirmCancel = $('confirmCancel');
const confirmOk     = $('confirmOk');

/* ── Helpers ─────────────────────────────────────────────────── */
function formatTime(ms) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const isToday = d.toDateString() === new Date().toDateString();
  if (isToday) return hhmm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

function avatarChar(name) {
  return name ? name.charAt(0).toUpperCase() : '?';
}

function isDesktop() {
  return window.innerWidth >= 768;
}

/* ── Mobile panel navigation ─────────────────────────────────── */
const panels = {
  contacts: $('panelContacts'),
  chat:     $('panelChat'),
  ai:       $('panelAi'),
};

let activePanelName = 'contacts';

function showPanel(name) {
  if (isDesktop()) return; // desktop shows all panels always
  activePanelName = name;

  // Set active class only on the target panel; remove from others
  Object.entries(panels).forEach(([key, el]) => {
    el.classList.toggle('panel-active', key === name);
  });

  // Bottom nav highlight
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === name);
  });

  // Header: show back button unless on contacts
  headerBack.hidden = (name === 'contacts');
  if (name === 'contacts') {
    headerTitle.textContent = 'AI Copilot';
  } else if (name === 'chat') {
    const c = contacts.find(x => x.id === currentContactId);
    headerTitle.textContent = c ? c.name : '聊天';
  } else {
    headerTitle.textContent = 'AI 助手';
  }
}

headerBack.addEventListener('click', () => {
  // Back: chat → contacts, ai → chat
  if (activePanelName === 'ai')   showPanel('chat');
  else                            showPanel('contacts');
});

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showPanel(btn.dataset.target));
});

/* ── API ─────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/* ── Contact list rendering ──────────────────────────────────── */
async function loadContacts() {
  contacts = await api('GET', '/api/contacts');
  renderContactList(contacts);
}

function renderContactList(list) {
  if (!list.length) {
    contactList.innerHTML = '<li class="list-empty">暂无联系人，用 Mock 栏发一条消息试试</li>';
    return;
  }
  contactList.innerHTML = list.map(c => `
    <li class="contact-item${c.id === currentContactId ? ' active' : ''}"
        data-id="${c.id}">
      <div class="contact-avatar">${avatarChar(c.name)}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name">${esc(c.name)}</span>
          <span class="contact-time">${c.last_time ? formatTime(c.last_time) : ''}</span>
        </div>
        <div class="contact-preview">${esc(c.last_message || '')}</div>
      </div>
      ${c.has_pending_suggestion ? '<div class="pending-dot"></div>' : ''}
    </li>
  `).join('');

  contactList.querySelectorAll('.contact-item').forEach(el => {
    const id = Number(el.dataset.id);
    if (aiGeneratingIds.has(id)) el.classList.add('ai-generating');
    el.addEventListener('click', () => selectContact(id));
    el.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, id); });
    addLongPressListener(el, (e) => showCtxMenu(e, id));
  });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Contact search ──────────────────────────────────────────── */
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  renderContactList(q ? contacts.filter(c => c.name.toLowerCase().includes(q)) : contacts);
});

/* ── Select a contact ────────────────────────────────────────── */
let _selectSeq = 0; // 防止快速切换时旧请求覆盖新内容

async function selectContact(id) {
  const seq = ++_selectSeq;
  currentContactId = id;
  renderContactList(contacts);

  const contact = contacts.find(c => c.id === id);
  if (contact) mockName.value = contact.name;

  if (contact?.has_pending_suggestion) {
    contact.has_pending_suggestion = 0;
    renderContactList(contacts);
    api('POST', `/api/contacts/${id}/read`);
  }

  await Promise.all([loadMessages(id), loadAiSession(id)]);

  // 如果在等待期间用户又切换了联系人，丢弃这次结果
  if (seq !== _selectSeq) return;

  if (!isDesktop()) showPanel('chat');
}

/* ── Chat messages ───────────────────────────────────────────── */
async function loadMessages(contactId) {
  const seq = _selectSeq;
  const data = await api('GET', `/api/contacts/${contactId}/messages`);
  if (seq !== _selectSeq) return; // 已切换到其他联系人
  renderMessages(data);
  chatPlaceholder.style.display = 'none';
  messages.style.display = 'flex';
  scrollToBottom(messages);
}

function renderMessages(msgs) {
  messages.innerHTML = msgs.map(m => buildMessageEl(m)).join('');
  messages.querySelectorAll('.message').forEach(el => {
    el.addEventListener('contextmenu', e => { e.preventDefault(); showMsgCtxMenu(e, el); });
    addLongPressListener(el, e => showMsgCtxMenu(e, el));
  });
}

function buildMessageEl(m) {
  const cls = m.is_self ? 'self' : 'other';
  const contact = contacts.find(c => c.id === m.contact_id);
  const senderName = m.is_self ? '我' : (contact ? contact.name : '对方');
  return `
    <div class="message ${cls}" data-msg-id="${m.id}" data-is-self="${m.is_self}">
      <div class="msg-sender">${esc(senderName)}</div>
      <div class="msg-bubble">${esc(m.content)}</div>
      <div class="msg-time">${formatTime(m.timestamp)}</div>
    </div>
  `;
}

function appendMessage(msg) {
  const div = document.createElement('div');
  div.innerHTML = buildMessageEl(msg);
  const el = div.firstElementChild;
  el.addEventListener('contextmenu', e => { e.preventDefault(); showMsgCtxMenu(e, el); });
  addLongPressListener(el, e => showMsgCtxMenu(e, el));
  messages.appendChild(el);
  scrollToBottom(messages);
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

/* ── AI session rendering ────────────────────────────────────── */
async function loadAiSession(contactId) {
  hideAiLoading(); // 清掉上一个联系人可能遗留的 loading
  const seq = _selectSeq;
  const data = await api('GET', `/api/contacts/${contactId}/ai-session`);
  if (seq !== _selectSeq) return; // 已切换到其他联系人
  hasAiSession = !!data;
  renderAiSession(data);
  aiPlaceholder.style.display = 'none';
  aiBody.style.display = 'flex';
  aiFollowup.style.display = 'flex';
  setFollowupEnabled(hasAiSession && !isStreaming);
  // 如果切换过来时该联系人仍在生成，补显 loading
  if (aiGeneratingIds.has(contactId)) showAiLoading();
}

/**
 * Render a complete AI session from DB.
 * messages: [ { type: 'ai_round', content: {analysis, candidates} }, { type: 'user', content: '...' }, ... ]
 * First ai_round → main area; rest → history section.
 */
function renderAiSession(data) {
  aiAnalysis.textContent = '';
  aiAnalysis.classList.remove('streaming');
  aiCandidates.innerHTML = '';
  aiHistory.innerHTML = '';
  candidateOffset = 0;

  if (!data) return;

  const msgs = data.messages;
  if (!msgs.length) return;

  // Find the first ai_round (main), rest go to history
  let firstRoundIdx = msgs.findIndex(m => m.type === 'ai_round');
  if (firstRoundIdx === -1) return;

  const firstRound = msgs[firstRoundIdx];
  aiAnalysis.textContent = firstRound.content.analysis || '';
  const firstCandidates = firstRound.content.candidates || [];
  renderCandidates(aiCandidates, firstCandidates, 1);
  candidateOffset = firstCandidates.length;

  // History: everything after first round
  const historyMsgs = msgs.slice(firstRoundIdx + 1);
  if (historyMsgs.length) {
    renderHistory(historyMsgs);
  }

  scrollToBottom(aiBody);
}

function renderCandidates(container, candidates, startNum) {
  container.innerHTML = candidates.map((text, i) => `
    <div class="candidate">
      <span class="candidate-num">${startNum + i}.</span>
      <span class="candidate-text">${esc(text)}</span>
      <button class="copy-btn" data-text="${esc(text)}" title="复制">&#128203;</button>
    </div>
  `).join('');

  container.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn, btn.dataset.text));
  });
}

function renderHistory(msgs) {
  if (!msgs.length) return;

  const sep = document.createElement('div');
  sep.className = 'history-sep';
  sep.textContent = '追问记录';
  aiHistory.appendChild(sep);

  for (const m of msgs) {
    if (m.type === 'user') {
      const el = document.createElement('div');
      el.className = 'history-user';
      el.textContent = m.content;
      aiHistory.appendChild(el);
    } else if (m.type === 'ai_round') {
      const analysis = m.content.analysis || '';
      const candidates = m.content.candidates || [];

      if (analysis) {
        const el = document.createElement('div');
        el.className = 'history-analysis';
        el.textContent = analysis;
        aiHistory.appendChild(el);
      }

      if (candidates.length) {
        const container = document.createElement('div');
        container.className = 'history-candidates';
        renderCandidates(container, candidates, candidateOffset + 1);
        candidateOffset += candidates.length;
        aiHistory.appendChild(container);
      }
    }
  }
}

async function copyText(btn, text) {
  await navigator.clipboard.writeText(text);
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1500);
}

/* ── WebSocket ───────────────────────────────────────────────── */
let ws;
let wsReconnectTimer;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('message', e => {
    const evt = JSON.parse(e.data);
    handleWsEvent(evt);
  });
  ws.addEventListener('close', () => {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, 3000);
  });
}

// 正在生成 AI 的联系人 id 集合（用于联系人列表显示 spinner）
const aiGeneratingIds = new Set();

function setContactGenerating(contactId, on) {
  if (on) aiGeneratingIds.add(contactId);
  else aiGeneratingIds.delete(contactId);
  // 更新对应联系人行
  const li = contactList.querySelector(`[data-id="${contactId}"]`);
  if (!li) return;
  li.classList.toggle('ai-generating', on);
}

function handleWsEvent(evt) {
  switch (evt.type) {
    case 'message':
      handleIncomingMessage(evt);
      break;
    case 'contacts_update':
      loadContacts();
      break;
    case 'ai_start':
      setContactGenerating(evt.contactId, true);
      if (evt.contactId === currentContactId) onAiStart(evt.fresh);
      break;
    case 'ai_chunk':
      if (evt.contactId === currentContactId) onAiChunk(evt.chunk);
      break;
    case 'ai_complete':
      setContactGenerating(evt.contactId, false);
      if (evt.contactId === currentContactId) onAiComplete(evt.result);
      else hideAiLoading();
      break;
    case 'ai_error':
      setContactGenerating(evt.contactId, false);
      if (evt.contactId === currentContactId) onAiError(evt.error);
      else hideAiLoading();
      break;
  }
}

function handleIncomingMessage(evt) {
  if (evt.contactId === currentContactId) {
    appendMessage(evt.message);
  }
}

/* ── AI streaming handlers ───────────────────────────────────── */

let _aiLoadingEl = null;

function showAiLoading(text = 'AI 生成中…') {
  if (_aiLoadingEl) return;
  _aiLoadingEl = document.createElement('div');
  _aiLoadingEl.className = 'ai-loading';
  _aiLoadingEl.innerHTML = '<div class="spinner"></div><span>' + text + '</span>';
  aiCurrent.insertBefore(_aiLoadingEl, aiAnalysis);
}

function hideAiLoading() {
  if (_aiLoadingEl) { _aiLoadingEl.remove(); _aiLoadingEl = null; }
}

function onAiStart(fresh = false) {
  isStreaming = true;
  hasAiSession = true;
  followupBtn.disabled = true;

  aiAnalysis.textContent = '';
  aiAnalysis.classList.add('streaming');
  aiCandidates.innerHTML = '';

  // 新消息触发（fresh）：完全重置面板，清掉旧追问记录
  if (fresh) {
    aiHistory.innerHTML = '';
    candidateOffset = 0;
  }

  aiPlaceholder.style.display = 'none';
  aiBody.style.display = 'flex';
  aiFollowup.style.display = 'flex';
  setFollowupEnabled(false);

  showAiLoading();
  scrollToBottom(aiBody);

  // 移动端自动跳到 AI 面板
  if (!isDesktop()) showPanel('ai');
}

function onAiChunk(chunk) {
  hideAiLoading(); // remove spinner on first real content
  aiAnalysis.textContent += chunk;
  scrollToBottom(aiBody);
}

function onAiComplete(result) {
  isStreaming = false;
  hideAiLoading();
  aiAnalysis.classList.remove('streaming');

  // Render candidates starting after existing ones
  renderCandidates(aiCandidates, result.candidates || [], candidateOffset + 1);
  candidateOffset += (result.candidates || []).length;

  setFollowupEnabled(true);
  scrollToBottom(aiBody);
}

function onAiError(errMsg) {
  isStreaming = false;
  hideAiLoading();
  aiAnalysis.classList.remove('streaming');
  aiAnalysis.textContent += `[错误：${errMsg}]`;
  setFollowupEnabled(true);
}

/* ── Follow-up ───────────────────────────────────────────────── */
function setFollowupEnabled(enabled) {
  followupInput.disabled = !enabled;
  followupBtn.disabled = !enabled;
  followupInput.placeholder = enabled ? '追问 AI…' : '请先触发 AI 生成建议';
}

async function sendFollowup() {
  const text = followupInput.value.trim();
  if (!text || !currentContactId || isStreaming || !hasAiSession) return;

  followupInput.value = '';
  setFollowupEnabled(false);

  // Append user message to history section in UI immediately
  if (!aiHistory.querySelector('.history-sep')) {
    const sep = document.createElement('div');
    sep.className = 'history-sep';
    sep.textContent = '追问记录';
    aiHistory.appendChild(sep);
  }

  const userEl = document.createElement('div');
  userEl.className = 'history-user';
  userEl.textContent = text;
  aiHistory.appendChild(userEl);

  // Move current analysis + candidates into history, reset current area
  const prevAnalysis = aiAnalysis.textContent;
  const prevCandidates = [...aiCandidates.querySelectorAll('.candidate-text')].map(el => el.textContent);

  if (prevAnalysis || prevCandidates.length) {
    if (prevAnalysis) {
      const el = document.createElement('div');
      el.className = 'history-analysis';
      el.textContent = prevAnalysis;
      aiHistory.insertBefore(el, userEl);
    }
    if (prevCandidates.length) {
      const container = document.createElement('div');
      container.className = 'history-candidates';
      // Re-render the previous candidates in history (they already have correct numbers)
      container.innerHTML = aiCandidates.innerHTML;
      aiHistory.insertBefore(container, prevAnalysis ? aiHistory.querySelector('.history-analysis + .history-user') || userEl : userEl);
    }
    aiAnalysis.textContent = '';
    aiCandidates.innerHTML = '';
  }

  scrollToBottom(aiBody);

  const res = await api('POST', `/api/contacts/${currentContactId}/followup`, { text });
  if (res.error) {
    // Roll back: remove the user bubble we just appended
    userEl.remove();
    followupInput.value = text;
    alert(`追问失败：${res.error}`);
    setFollowupEnabled(true);
  }
  // On success the server triggers AI; onAiStart/onAiComplete will re-enable the input
}

followupBtn.addEventListener('click', sendFollowup);

followupInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFollowup();
  }
});

/* ── Mock bar ────────────────────────────────────────────────── */
const mockSelfLabel = $('mockSelfLabel');

mockToggle.addEventListener('click', () => {
  const closed = mockControls.classList.toggle('closed');
  mockToggleArrow.textContent = closed ? '▲' : '▼';
});

// 勾选"我发的"时隐藏联系人名（用当前联系人），取消时显示
mockIsSelf.addEventListener('change', () => {
  mockSelfLabel.textContent = mockIsSelf.checked ? '我发的' : '对方发的';
  mockName.style.display = mockIsSelf.checked ? 'none' : '';
});

mockSend.addEventListener('click', async () => {
  const content = mockMsg.value.trim();
  if (!content) return;

  let wxid, name;

  if (mockIsSelf.checked) {
    // "我发的" → 发到当前联系人的对话里
    if (!currentContactId) {
      alert('请先选择一个联系人');
      return;
    }
    const contact = contacts.find(c => c.id === currentContactId);
    wxid = contact.wxid;
    name = contact.name;
  } else {
    // "对方发的" → 如果当前选中联系人且名字匹配，直接用该联系人的 wxid
    name = mockName.value.trim();
    if (!name) { alert('请输入联系人名'); return; }
    const matched = currentContactId && contacts.find(c => c.id === currentContactId && c.name === name);
    wxid = matched ? matched.wxid : `mock_${name}`;
  }

  const noAi = $('mockNoAi').checked;
  await api('POST', '/api/mock/message', { wxid, name, content, isSelf: mockIsSelf.checked, noAi });
  mockMsg.value = '';
});

mockMsg.addEventListener('keydown', e => {
  if (e.key === 'Enter') mockSend.click();
});

mockTrigger.addEventListener('click', async () => {
  if (!currentContactId) {
    alert('请先选择一个联系人');
    return;
  }
  await api('POST', '/api/mock/trigger', { contactId: currentContactId });
});

/* ── Message context menu ────────────────────────────────────── */

let ctxMsgId = null;
let ctxMsgEl = null;

function showMsgCtxMenu(e, el) {
  ctxMsgId = Number(el.dataset.msgId);
  ctxMsgEl = el;
  const x = e.clientX ?? e.pageX;
  const y = e.clientY ?? e.pageY;
  msgCtxMenu.hidden = false;
  const mw = msgCtxMenu.offsetWidth || 160;
  const mh = msgCtxMenu.offsetHeight || 110;
  msgCtxMenu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  msgCtxMenu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function hideMsgCtxMenu() { msgCtxMenu.hidden = true; ctxMsgId = null; ctxMsgEl = null; }

document.addEventListener('click', e => { if (!msgCtxMenu.contains(e.target)) hideMsgCtxMenu(); });
document.addEventListener('touchstart', e => { if (!msgCtxMenu.contains(e.target)) hideMsgCtxMenu(); }, { passive: true });

$('msgCtxDelete').addEventListener('click', async () => {
  if (!ctxMsgId) return;
  const id = ctxMsgId;
  const el = ctxMsgEl;
  hideMsgCtxMenu();
  await api('DELETE', `/api/messages/${id}`);
  el?.remove();
});

$('msgCtxFlip').addEventListener('click', async () => {
  if (!ctxMsgId || !ctxMsgEl) return;
  const id = ctxMsgId;
  const el = ctxMsgEl;
  const wasSelf = el.dataset.isSelf === '1';
  hideMsgCtxMenu();
  await api('POST', `/api/messages/${id}`, { isSelf: !wasSelf });
  // Update element in place
  el.dataset.isSelf = wasSelf ? '0' : '1';
  el.classList.toggle('self', !wasSelf);
  el.classList.toggle('other', wasSelf);
  const senderEl = el.querySelector('.msg-sender');
  if (senderEl) {
    if (!wasSelf) {
      senderEl.textContent = '我';
    } else {
      const contact = contacts.find(c => c.id === currentContactId);
      senderEl.textContent = contact ? contact.name : '对方';
    }
  }
});

$('msgCtxEdit').addEventListener('click', () => {
  if (!ctxMsgId || !ctxMsgEl) return;
  const id = ctxMsgId;
  const el = ctxMsgEl;
  const bubbleEl = el.querySelector('.msg-bubble');
  const currentText = bubbleEl?.textContent ?? '';
  hideMsgCtxMenu();
  showInputModal('编辑消息', currentText, '消息内容', async (newContent) => {
    await api('POST', `/api/messages/${id}`, { content: newContent });
    if (bubbleEl) bubbleEl.textContent = newContent;
  });
});

/* ── Contact management ──────────────────────────────────────── */

// 长按检测（500ms）
function addLongPressListener(el, callback) {
  let timer = null;
  let moved = false;
  el.addEventListener('touchstart', e => {
    moved = false;
    timer = setTimeout(() => { if (!moved) callback(e.touches[0]); }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', () => { moved = true; clearTimeout(timer); }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(timer), { passive: true });
}

// 当前右键目标 contactId
let ctxContactId = null;

function showCtxMenu(e, contactId) {
  ctxContactId = contactId;
  const x = e.clientX ?? e.pageX;
  const y = e.clientY ?? e.pageY;
  ctxMenu.hidden = false;
  // 防止菜单超出屏幕
  const mw = ctxMenu.offsetWidth || 160;
  const mh = ctxMenu.offsetHeight || 120;
  ctxMenu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function hideCtxMenu() { ctxMenu.hidden = true; ctxContactId = null; }

document.addEventListener('click', e => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
document.addEventListener('touchstart', e => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); }, { passive: true });

$('ctxNotes').addEventListener('click', () => {
  const c = contacts.find(x => x.id === ctxContactId);
  if (!c) return;
  notesInput.value = c.notes || '';
  notesMask.hidden = false;
  setTimeout(() => notesInput.focus(), 50);

  const doSave = async () => {
    notesMask.hidden = true;
    cleanup();
    await api('POST', `/api/contacts/${c.id}/notes`, { notes: notesInput.value.trim() });
    // 更新本地缓存
    const local = contacts.find(x => x.id === c.id);
    if (local) local.notes = notesInput.value.trim();
  };
  const doCancel = () => { notesMask.hidden = true; cleanup(); };
  const onKey = (e) => { if (e.key === 'Escape') doCancel(); };

  notesSave.addEventListener('click', doSave);
  notesCancel.addEventListener('click', doCancel);
  notesMask.addEventListener('click', e => { if (e.target === notesMask) doCancel(); });
  notesInput.addEventListener('keydown', onKey);

  function cleanup() {
    notesSave.removeEventListener('click', doSave);
    notesCancel.removeEventListener('click', doCancel);
    notesInput.removeEventListener('keydown', onKey);
  }
});

ctxRename.addEventListener('click', () => {
  const c = contacts.find(x => x.id === ctxContactId);
  if (!c) return;
  showInputModal('修改名称', c.name, '联系人名称', async (name) => {
    await api('POST', `/api/contacts/${c.id}/rename`, { name });
    await loadContacts();
  });
});

ctxClear.addEventListener('click', () => {
  const c = contacts.find(x => x.id === ctxContactId);
  if (!c) return;
  showConfirmModal(
    '清空聊天记录',
    `确定清空「${c.name}」的所有聊天记录？此操作不可恢复。`,
    async () => {
      await api('POST', `/api/contacts/${c.id}/clear-messages`);
      if (currentContactId === c.id) {
        messages.innerHTML = '';
        scrollToBottom(messages);
      }
      await loadContacts();
    }
  );
});

ctxDelete.addEventListener('click', () => {
  const c = contacts.find(x => x.id === ctxContactId);
  if (!c) return;
  showConfirmModal(
    '删除联系人',
    `确定删除「${c.name}」？聊天记录和 AI 建议将一并删除，不可恢复。`,
    async () => {
      await api('DELETE', `/api/contacts/${c.id}`);
      if (currentContactId === c.id) {
        currentContactId = null;
        messages.innerHTML = '';
        chatPlaceholder.style.display = '';
        aiPlaceholder.style.display = '';
        aiBody.style.display = 'none';
        aiFollowup.style.display = 'none';
        hasAiSession = false;
      }
      await loadContacts();
    }
  );
});

// 新建联系人
addContactBtn.addEventListener('click', () => {
  showInputModal('新建联系人', '', '输入联系人名称', async (name) => {
    await api('POST', '/api/contacts', { name });
    await loadContacts();
  });
});

// 通用输入弹窗
function showInputModal(title, defaultValue, placeholder, onConfirm) {
  modalTitle.textContent = title;
  modalInput.value = defaultValue;
  modalInput.placeholder = placeholder;
  modalMask.hidden = false;
  setTimeout(() => { modalInput.focus(); modalInput.select(); }, 50);

  const doConfirm = async () => {
    const val = modalInput.value.trim();
    if (!val) return;
    modalMask.hidden = true;
    cleanup();
    await onConfirm(val);
  };

  const doCancel = () => { modalMask.hidden = true; cleanup(); };

  const onKey = (e) => { if (e.key === 'Enter') doConfirm(); if (e.key === 'Escape') doCancel(); };

  modalConfirm.addEventListener('click', doConfirm);
  modalCancel.addEventListener('click', doCancel);
  modalInput.addEventListener('keydown', onKey);
  modalMask.addEventListener('click', e => { if (e.target === modalMask) doCancel(); });

  function cleanup() {
    modalConfirm.removeEventListener('click', doConfirm);
    modalCancel.removeEventListener('click', doCancel);
    modalInput.removeEventListener('keydown', onKey);
  }
}

// 通用确认弹窗
function showConfirmModal(title, body, onConfirm) {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmMask.hidden = false;

  const doConfirm = async () => { confirmMask.hidden = true; cleanup(); await onConfirm(); };
  const doCancel  = () => { confirmMask.hidden = true; cleanup(); };

  confirmOk.addEventListener('click', doConfirm);
  confirmCancel.addEventListener('click', doCancel);
  confirmMask.addEventListener('click', e => { if (e.target === confirmMask) doCancel(); });

  function cleanup() {
    confirmOk.removeEventListener('click', doConfirm);
    confirmCancel.removeEventListener('click', doCancel);
  }
}

/* ── Web Push ────────────────────────────────────────────────── */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

let _pushSubscription = null;
const pushBtn = $('pushBtn');

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !pushBtn) return;

  const { key } = await api('GET', '/api/push/vapid-public-key');
  if (!key) return;  // 服务端未配置 VAPID，不显示按钮

  pushBtn.hidden = false;
  const reg = await navigator.serviceWorker.ready;
  _pushSubscription = await reg.pushManager.getSubscription();
  _updatePushBtn();
}

function _updatePushBtn() {
  if (!pushBtn) return;
  pushBtn.title   = _pushSubscription ? '关闭通知' : '开启通知';
  pushBtn.style.opacity = _pushSubscription ? '1' : '0.4';
}

pushBtn && pushBtn.addEventListener('click', async () => {
  const reg = await navigator.serviceWorker.ready;
  if (_pushSubscription) {
    // 取消订阅
    await api('DELETE', '/api/push/subscribe', { endpoint: _pushSubscription.endpoint });
    await _pushSubscription.unsubscribe();
    _pushSubscription = null;
  } else {
    // 请求权限并订阅
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { alert('请允许通知权限'); return; }

    const { key } = await api('GET', '/api/push/vapid-public-key');
    if (!key) return;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    _pushSubscription = sub;
    const j = sub.toJSON();
    await api('POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
  }
  _updatePushBtn();
});

// Service Worker → 主页面：点击通知后切换到对应联系人
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data?.type === 'open_contact' && e.data.contactId) {
    selectContact(Number(e.data.contactId));
  }
});

/* ── Init ────────────────────────────────────────────────────── */
async function init() {
  // On mobile, start with contacts panel active; others are hidden by CSS default
  if (!isDesktop()) {
    showPanel('contacts');
  }

  // Hide AI body and followup until a contact is selected
  aiBody.style.display = 'none';
  aiFollowup.style.display = 'none';
  messages.style.display = 'none';
  setFollowupEnabled(false);

  await loadContacts();
  connectWs();
  initPush();
}

init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

// PWA 安装按钮
let _installPrompt = null;
const installBtn = document.getElementById('installBtn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  const { outcome } = await _installPrompt.userChoice;
  if (outcome === 'accepted') installBtn.hidden = true;
  _installPrompt = null;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  _installPrompt = null;
});
