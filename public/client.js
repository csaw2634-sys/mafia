// 마피아 게임 클라이언트
const socket = io();
const $ = (sel) => document.querySelector(sel);

const ROLE = {
  mafia:   { name: '마피아', icon: '🔪', team: '마피아 팀', desc: '밤마다 동료와 함께 한 명을 제거합니다. 낮에는 시민인 척 연기하세요.' },
  police:  { name: '경찰',   icon: '🕵️', team: '시민 팀',   desc: '밤마다 한 명을 조사해 마피아인지 알아냅니다. 결과는 대화창에 나만 보여요.' },
  doctor:  { name: '의사',   icon: '💉', team: '시민 팀',   desc: '밤마다 한 명을 골라 마피아의 습격에서 지켜 줍니다. 나 자신도 지킬 수 있어요.' },
  citizen: { name: '시민',   icon: '🙂', team: '시민 팀',   desc: '특별한 능력은 없지만, 대화와 투표로 마피아를 찾아낼 수 있어요.' },
};
const AVATARS = ['🦊', '🐻', '🐼', '🐯', '🐸', '🐵', '🐧', '🐙', '🦉', '🐺'];
const QUICK = ['😂', '😱', '🤔', '😡', '😭', '👍', '🙏', '🔪', '👀', '🤫'];
const EMOJIS = [
  '😀','😁','😂','🤣','😅','😊','😉','😍','😘','😎','🤩','🥳',
  '🤔','🤨','😐','😑','🙄','😏','😬','🤥','😳','🥺','😢','😭',
  '😤','😡','🤬','😱','😨','😰','😴','🤐','🤫','🤭','🫢','😈',
  '👀','👍','👎','👏','🙌','🙏','🤝','✌️','🤞','👉','🫵','💪',
  '🔪','🩸','💀','☠️','⚰️','🕵️','💉','🩺','🚓','⚖️','🗳️','🎭',
  '🌙','⭐','☀️','🔥','💥','💯','❓','❗','❤️','💔','🎉','🍀',
];

// ───── 세션 (새로고침해도 자리 유지) ─────
function makeId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function store(key, val) {
  try { val === null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch (e) {}
}
function load(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
let pid = load('mafia-pid');
if (!pid) { pid = makeId(); store('mafia-pid', pid); }
let session = null;
try { session = JSON.parse(load('mafia-session') || 'null'); } catch (e) {}

let state = null;
let localDeadline = null;
let total = null;
let lastEventSeq = null;
let lastPhase = null;
let bannerTimer = null;

// ───── 첫 화면 ─────
$('#nameInput').value = load('mafia-name') || '';

$('#createBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  if (!name) return toast('닉네임을 입력해 주세요.');
  store('mafia-name', name);
  socket.emit('create', { name, pid });
};
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!name) return toast('닉네임을 입력해 주세요.');
  if (code.length !== 4) return toast('방 코드 4자리를 입력해 주세요.');
  store('mafia-name', name);
  socket.emit('join', { code, name, pid });
};
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('#codeInput').value.trim() ? $('#joinBtn') : $('#createBtn')).click();
});

// 주소에 ?room=ABCD 가 있으면 코드 자동 입력
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('#codeInput').value = urlRoom.toUpperCase().slice(0, 4);

$('#codeBtn').onclick = async () => {
  if (!state) return;
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('초대 링크를 복사했어요. 친구에게 보내 주세요!');
  } catch (e) {
    toast(`방 코드: ${state.code}`);
  }
};

$('#leaveBtn').onclick = () => {
  const inGame = state && !['lobby', 'ended'].includes(state.phase);
  if (inGame && !confirm('게임 중에 나가면 사망 처리돼요. 정말 나갈까요?')) return;
  socket.emit('leave');
  goHome();
};

function goHome(keepSession = false) {
  session = null;
  if (!keepSession) store('mafia-session', null);
  state = null;
  lastEventSeq = null;
  lastPhase = null;
  peeking = false;
  clearInterval(peekTimer);
  $('#game').classList.add('hidden');
  $('#home').classList.remove('hidden');
  document.body.className = 'phase-lobby';
  $('#messages').innerHTML = '';
}

// ───── 소켓 ─────
socket.on('connect', () => {
  if (session) socket.emit('join', { code: session.code, name: session.name, pid });
});
socket.on('joined', ({ code, name }) => {
  session = { code, name };
  store('mafia-session', JSON.stringify(session));
  $('#home').classList.add('hidden');
  $('#game').classList.remove('hidden');
  if (urlRoom) history.replaceState(null, '', location.pathname);
});
socket.on('errorMsg', (msg, opts) => {
  toast(msg);
  if (session && (opts?.noRoom || !state)) goHome();
});
socket.on('kicked', (msg) => { toast(msg); goHome(true); });
socket.on('toast', toast);
socket.on('history', (msgs) => {
  $('#messages').innerHTML = '';
  msgs.forEach(addMessage);
});
socket.on('chat', addMessage);
socket.on('state', (s) => {
  state = s;
  if (s.remaining != null) {
    localDeadline = Date.now() + s.remaining;
    total = s.total;
  } else {
    localDeadline = null;
    total = null;
  }
  render();
});

// ───── 렌더링 ─────
function render() {
  const s = state;
  document.body.className = `phase-${s.phase}`;
  $('#codeText').textContent = s.code;

  renderSky();
  renderRoleCard();
  renderPlayers();
  renderLobby();
  renderEnd();
  renderChatPermission();
  handleBanner();
  tick();
}

function renderSky() {
  const s = state;
  const mine = s.me;
  const n = s.night;

  let title = '';
  let prompt = '';
  const extra = $('#promptExtra');
  extra.innerHTML = '';

  if (s.phase === 'lobby') {
    title = '대기실';
    prompt = `친구들이 모이면 방장이 게임을 시작해요. 방 코드를 눌러 초대 링크를 복사할 수 있어요.`;
  } else if (s.phase === 'reveal') {
    title = '역할 배정';
    prompt = '참가자 칸의 내 카드에서 역할을 확인하세요. 옆 사람이 보지 않게 조심!';
  } else if (s.phase === 'night') {
    title = `${s.day}일차 밤`;
    if (!mine.alive) {
      prompt = `💀 관전 중이에요. 지금은 ${ROLE[n?.turnRole]?.name || '누군가'}의 차례입니다.`;
    } else if (n?.myTurn) {
      if (mine.role === 'mafia') {
        prompt = n.locked ? '동료와 의견이 모였어요. 곧 다음 차례로 넘어갑니다.'
          : '제거할 사람을 고르세요. 동료 마피아와 같은 사람을 고르면 바로 확정돼요.';
        const picks = Object.entries(n.mafiaPicks || {});
        picks.forEach(([mid, tid]) => {
          const m = s.players.find((p) => p.id === mid);
          const t = s.players.find((p) => p.id === tid);
          if (m && t) extra.appendChild(tag(`${m.name} → ${t.name}`, 'mafia'));
        });
      } else if (mine.role === 'doctor') {
        prompt = n.myChoice ? `오늘 밤 ${nameOf(n.myChoice)}님을 지킵니다. 💉` : '오늘 밤 지켜 줄 사람을 고르세요.';
      } else if (mine.role === 'police') {
        prompt = n.myChoice ? `${nameOf(n.myChoice)}님을 조사했어요. 결과는 대화창을 확인하세요.` : '조사할 사람을 고르세요. 한 번만 고를 수 있어요.';
      }
    } else if (mine.role === 'mafia') {
      prompt = '다른 사람이 움직이는 중이에요. 마피아끼리는 대화창에서 몰래 이야기할 수 있어요.';
    } else {
      prompt = '밤이 깊었습니다… 누군가 움직이고 있어요. 조용히 기다려 주세요.';
    }
  } else if (s.phase === 'day') {
    title = `${s.day}일차 낮`;
    const voters = s.players.filter((p) => p.alive);
    const voted = Object.keys(s.votes).filter((id) => voters.some((v) => v.id === id)).length;
    if (!mine.alive) {
      prompt = '💀 관전 중이에요. 망자끼리만 대화할 수 있어요.';
    } else {
      const myVote = s.votes[mine.id];
      prompt = myVote
        ? `${myVote === 'skip' ? '기권' : nameOf(myVote) + '님'}에게 투표했어요. 같은 사람을 다시 누르면 취소돼요.`
        : '토론하고, 마피아로 의심되는 사람을 눌러 투표하세요.';
      if (!s.voteLocked) {
        const skip = document.createElement('button');
        skip.className = 'btn small' + (myVote === 'skip' ? ' primary' : '');
        skip.textContent = '🙅 기권';
        skip.onclick = () => socket.emit('vote', 'skip');
        extra.appendChild(skip);
      }
    }
    const info = document.createElement('span');
    info.className = 'muted';
    const skips = Object.values(s.votes).filter((v) => v === 'skip').length;
    info.textContent = `투표 ${voted}/${voters.length}명` + (skips ? ` · 기권 ${skips}` : '');
    extra.appendChild(info);
  } else if (s.phase === 'execution') {
    title = '투표 결과';
    prompt = s.event?.title ? `${s.event.title}. 곧 밤이 찾아옵니다.` : '곧 밤이 찾아옵니다.';
  } else if (s.phase === 'ended') {
    title = s.winner === 'mafia' ? '마피아 팀 승리' : '시민 팀 승리';
    prompt = '모든 역할이 공개되었어요.';
  }
  $('#phaseTitle').textContent = title;
  $('#promptText').textContent = prompt;
}

const PEEK_SECONDS = 3;
let peeking = false;
let peekLeft = 0;
let peekTimer = null;

function teammates() {
  // 서버는 같은 편 동료의 역할만 알려 줌 (지금은 마피아끼리만)
  return state.players.filter((p) => p.id !== state.me.id && p.role && p.role === state.me.role);
}

function renderRoleCard() {
  const card = $('#roleCard');
  if (!state.me.role || state.phase === 'lobby' || state.phase === 'ended') return card.classList.add('hidden');

  // 누구나 같은 버튼, 같은 모양 — 겉으로는 역할을 알 수 없게
  card.className = 'role-card' + (peeking ? ' peeking' : '');
  const info = $('#roleInfo');
  if (!peeking) {
    info.textContent = `누르면 ${PEEK_SECONDS}초 동안 함께하는 동료를 확인할 수 있어요.`;
    $('#peekLabel').textContent = '🔒 동료 확인';
    return;
  }
  if (!state.me.alive) {
    info.textContent = '💀 관전 중이라 참가자 칸에 모든 역할이 보여요.';
  } else {
    const mates = teammates().map((p) => p.name);
    info.textContent = mates.length ? `동료: ${mates.join(', ')}` : '함께하는 동료가 없어요.';
  }
  $('#peekLabel').textContent = `🔓 ${peekLeft}초 후 가려져요`;
}

function startPeek() {
  peeking = true;
  peekLeft = PEEK_SECONDS;
  clearInterval(peekTimer);
  peekTimer = setInterval(() => {
    peekLeft -= 1;
    if (peekLeft <= 0) stopPeek();
    else if (state) renderRoleCard();
  }, 1000);
  if (state) { renderRoleCard(); renderPlayers(); }
}

function stopPeek() {
  peeking = false;
  clearInterval(peekTimer);
  peekTimer = null;
  if (state) { renderRoleCard(); renderPlayers(); }
}

$('#peekBtn').onclick = () => (peeking ? stopPeek() : startPeek());

function canTarget(p) {
  const s = state, mine = s.me, n = s.night;
  if (!mine.alive || !p.alive) return false;
  if (s.phase === 'day') return !s.voteLocked && p.id !== mine.id;
  if (s.phase === 'night' && n?.myTurn && !n.locked) {
    if (mine.role === 'mafia') return p.role !== 'mafia';
    if (mine.role === 'doctor') return true;
    if (mine.role === 'police') return p.id !== mine.id && !n.myChoice;
  }
  return false;
}

function renderPlayers() {
  const s = state;
  const box = $('#players');
  box.innerHTML = '';

  const tally = {};
  for (const t of Object.values(s.votes || {})) tally[t] = (tally[t] || 0) + 1;
  const mafiaPickCount = {};
  if (s.night?.mafiaPicks) for (const t of Object.values(s.night.mafiaPicks)) mafiaPickCount[t] = (mafiaPickCount[t] || 0) + 1;

  const alive = s.players.filter((p) => p.alive).length;
  $('#aliveCount').textContent = s.phase === 'lobby' ? `${s.players.length} / ${s.config.MAX_PLAYERS}명` : `생존 ${alive}명 / ${s.players.length}명`;

  s.players.forEach((p, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pcard';
    const selectable = canTarget(p);
    if (selectable) card.classList.add('selectable');
    else card.tabIndex = -1;
    if (!p.alive && s.phase !== 'lobby') card.classList.add('dead');
    if (p.id === s.me.id) card.classList.add('me');

    const selected = (s.phase === 'day' && s.votes[s.me.id] === p.id) ||
      (s.phase === 'night' && s.night?.myTurn && s.night.myChoice === p.id);
    if (selected) card.classList.add('selected');

    const av = el('div', 'p-avatar', AVATARS[i % AVATARS.length]);
    const name = el('div', 'p-name', p.name);
    const tags = el('div', 'p-tags');
    if (p.id === s.me.id) tags.append(tag('나'));
    if (p.isHost) tags.append(tag('👑 방장', 'host'));
    const showRole = p.role && s.phase !== 'lobby' && (
      s.phase === 'ended' || p.id === s.me.id ||
      (peeking && (!s.me.alive || p.role === s.me.role)));
    if (showRole) tags.append(tag(`${ROLE[p.role].icon} ${ROLE[p.role].name}`, p.role));
    if (!p.connected) tags.append(tag(p.left ? '🚪 나감' : '📴 끊김'));
    card.append(av, name, tags);

    if ((s.phase === 'day' || s.phase === 'execution') && tally[p.id]) {
      card.append(el('div', 'vote-chip', String(tally[p.id])));
    }
    if (s.phase === 'night' && mafiaPickCount[p.id]) {
      card.append(el('div', 'pick-dots', '🔪'.repeat(mafiaPickCount[p.id])));
    }

    card.onclick = () => {
      if (!canTarget(p)) return;
      if (s.phase === 'day') socket.emit('vote', p.id);
      else if (s.phase === 'night') socket.emit('nightAction', p.id);
    };
    box.append(card);
  });
}

function renderLobby() {
  const panel = $('#lobbyPanel');
  const s = state;
  if (s.phase !== 'lobby') return panel.classList.add('hidden');
  panel.classList.remove('hidden');
  panel.innerHTML = '';

  const n = s.players.length;
  const min = s.config.MIN_PLAYERS;
  const t = s.roleTable[n];

  panel.append(el('h4', null, n >= min ? `${n}명이면 이렇게 나뉘어요` : `${min - n}명이 더 필요해요`));
  panel.append(el('p', 'muted', '인원에 맞춰 마피아·경찰·의사 수가 자동으로 정해집니다.'));

  if (t) {
    const dist = el('div', 'dist');
    dist.append(
      tag(`🔪 마피아 ${t.mafia}`, 'mafia'),
      tag(`🕵️ 경찰 ${t.police}`, 'police'),
      tag(`💉 의사 ${t.doctor}`, 'doctor'),
      tag(`🙂 시민 ${n - t.mafia - t.police - t.doctor}`, 'citizen'),
    );
    panel.append(dist);
  }

  const wrap = el('div', 'table-wrap');
  const table = el('table', 'role-table');
  const counts = Object.keys(s.roleTable).map(Number);
  table.innerHTML = `<thead><tr><th>인원</th>${counts.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = document.createElement('tbody');
  [['mafia', '🔪'], ['police', '🕵️'], ['doctor', '💉'], ['citizen', '🙂']].forEach(([key, ic]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${ic}</td>` + counts.map((c) => {
      const r = s.roleTable[c];
      const v = key === 'citizen' ? c - r.mafia - r.police - r.doctor : r[key];
      return `<td>${v}</td>`;
    }).join('');
    tbody.append(tr);
  });
  table.append(tbody);
  // 현재 인원 열 강조
  table.querySelectorAll('tr').forEach((tr) => {
    const idx = counts.indexOf(n);
    if (idx >= 0) tr.children[idx + 1]?.classList.add('now');
  });
  wrap.append(table);
  panel.append(wrap);

  if (s.me.isHost) {
    const btn = el('button', 'btn primary wide', n >= min ? `${n}명으로 게임 시작` : `${min}명부터 시작할 수 있어요`);
    btn.disabled = n < min;
    btn.onclick = () => socket.emit('start');
    panel.append(btn);
  } else {
    panel.append(el('p', 'muted', '👑 방장이 게임을 시작하기를 기다리는 중…'));
  }
}

function renderEnd() {
  const panel = $('#endPanel');
  const s = state;
  if (s.phase !== 'ended') return panel.classList.add('hidden');
  panel.classList.remove('hidden');
  panel.innerHTML = '';
  const mafiaWin = s.winner === 'mafia';
  panel.append(el('div', 'end-title' + (mafiaWin ? ' mafia' : ''), mafiaWin ? '🔪 마피아 팀 승리' : '🎉 시민 팀 승리'));
  const mafias = s.players.filter((p) => p.role === 'mafia').map((p) => p.name).join(', ');
  panel.append(el('p', 'muted', `마피아는 ${mafias}였습니다.`));
  if (s.me.isHost) {
    const btn = el('button', 'btn primary', '🔁 한 판 더 하기');
    btn.onclick = () => socket.emit('restart');
    panel.append(btn);
  } else {
    panel.append(el('p', 'muted', '방장이 한 판 더 하기를 누르면 대기실로 돌아가요.'));
  }
}

// ───── 채팅 ─────
function chatMode() {
  const s = state;
  if (!s) return { ok: false };
  if (s.phase === 'lobby' || s.phase === 'ended') return { ok: true, label: '전체', cls: '' };
  if (!s.me.alive) return { ok: true, label: '💀 망자 채팅', cls: 'dead' };
  if (s.phase === 'reveal') return { ok: false, label: '잠시 대기', cls: 'off', hint: '역할을 확인하는 중이에요' };
  if (s.phase === 'night') {
    if (s.me.role === 'mafia') return { ok: true, label: '🔪 마피아 채팅', cls: 'mafia' };
    return { ok: false, label: '🤫 밤에는 대화 금지', cls: 'off', hint: '밤에는 대화할 수 없어요' };
  }
  return { ok: true, label: '전체', cls: '' };
}

function renderChatPermission() {
  const m = chatMode();
  const ch = $('#chatChannel');
  ch.textContent = m.label || '';
  ch.className = 'channel ' + (m.cls || '');
  const input = $('#chatInput');
  input.disabled = !m.ok;
  input.placeholder = m.ok ? (m.cls === 'mafia' ? '마피아끼리만 보여요' : m.cls === 'dead' ? '망자끼리만 보여요' : '메시지 입력') : m.hint;
  document.querySelectorAll('#quickBar button').forEach((b) => (b.disabled = !m.ok));
  $('#emojiBtn').disabled = !m.ok;
  if (!m.ok) $('#emojiPanel').classList.add('hidden');
}

function isEmojiOnly(text) {
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s){1,12}$/u.test(text) && /\p{Extended_Pictographic}/u.test(text);
}

function addMessage(m) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const div = document.createElement('div');

  if (m.channel === 'system') {
    div.className = 'msg system' + (m.private ? ' private' : '');
    div.textContent = m.text;
  } else {
    div.className = `msg ch-${m.channel}` + (state && m.fromId === state.me.id ? ' mine' : '') + (isEmojiOnly(m.text) ? ' emoji-only' : '');
    const from = el('div', 'm-from');
    if (m.channel === 'mafia') from.append(el('span', 'ch-badge mafia', '마피아'));
    if (m.channel === 'dead') from.append(el('span', 'ch-badge', '망자'));
    from.append(document.createTextNode(m.from));
    div.append(from, el('div', 'm-text', m.text));
  }
  box.append(div);
  if (nearBottom || (state && m.fromId === state.me.id)) box.scrollTop = box.scrollHeight;
}

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  input.value = '';
  $('#emojiPanel').classList.add('hidden');
});

QUICK.forEach((emo) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emo;
  b.title = `${emo} 보내기`;
  b.onclick = () => socket.emit('chat', emo);
  $('#quickBar').append(b);
});

EMOJIS.forEach((emo) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emo;
  b.onclick = () => {
    const input = $('#chatInput');
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + emo + input.value.slice(pos);
    input.focus();
    input.setSelectionRange(pos + emo.length, pos + emo.length);
  };
  $('#emojiPanel').append(b);
});
$('#emojiBtn').onclick = () => $('#emojiPanel').classList.toggle('hidden');
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emojiPanel') && !e.target.closest('#emojiBtn')) $('#emojiPanel').classList.add('hidden');
});

// ───── 배너 (장면 전환) ─────
function handleBanner() {
  const s = state;
  const ev = s.event;
  const first = lastEventSeq === null;
  lastPhase = s.phase;
  if (!ev) { lastEventSeq = 0; return; }
  if (first) { lastEventSeq = ev.seq; return; } // 재접속 직후에는 지난 배너를 띄우지 않음
  if (ev.seq === lastEventSeq) return;
  lastEventSeq = ev.seq;

  if (s.phase === 'reveal') {
    showBanner('🎭', '역할이 정해졌어요', '참가자 칸의 내 카드에서 몰래 확인하세요');
  } else {
    showBanner(ev.icon, ev.title, ev.sub);
  }
}

function showBanner(icon, title, sub) {
  $('#bannerIcon').textContent = icon;
  $('#bannerTitle').textContent = title;
  $('#bannerSub').textContent = sub || '';
  $('#banner').classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('#banner').classList.add('hidden'), 2800);
}
$('#banner').onclick = () => $('#banner').classList.add('hidden');

// ───── 타이머 ─────
function tick() {
  const text = $('#timerText');
  const fill = $('#timeFill');
  if (!state || !localDeadline) {
    text.textContent = '';
    fill.style.width = '0';
    text.classList.remove('urgent');
    fill.classList.remove('urgent');
    return;
  }
  const left = Math.max(0, localDeadline - Date.now());
  const sec = Math.ceil(left / 1000);
  text.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  fill.style.width = `${(total ? left / total : 0) * 100}%`;
  const urgent = sec <= 10 && ['day', 'night'].includes(state.phase);
  text.classList.toggle('urgent', urgent);
  fill.classList.toggle('urgent', urgent);
}
setInterval(tick, 250);

// ───── 도우미 ─────
function el(tagName, cls, text) {
  const e = document.createElement(tagName);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function tag(text, cls = '') { return el('span', 'tag ' + cls, text); }
function nameOf(id) { return state.players.find((p) => p.id === id)?.name || '?'; }

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
