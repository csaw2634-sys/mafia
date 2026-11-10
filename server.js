// 마피아 게임 서버 — 컴퓨터가 사회자 역할을 맡습니다.
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ───────── 설정 (원하는 대로 바꿔도 됩니다) ─────────
const CONFIG = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 10,
  DAY_SECONDS: 120,              // 낮: 2분
  NIGHT_SECONDS_PER_PLAYER: 30,  // 밤: 능력 사용자 1명당 30초
  ROLE_REVEAL_SECONDS: 6,        // 역할 확인 시간
  AFTER_VOTE_SECONDS: 6,         // 처형 발표 후 밤까지
};

// 인원수에 따라 마피아·경찰·의사 수가 자동으로 정해집니다. 나머지는 시민.
const ROLE_TABLE = {
  4: { mafia: 1, police: 1, doctor: 0 },
  5: { mafia: 1, police: 1, doctor: 1 },
  6: { mafia: 2, police: 1, doctor: 1 },
  7: { mafia: 2, police: 1, doctor: 1 },
  8: { mafia: 2, police: 1, doctor: 1 },
  9: { mafia: 3, police: 1, doctor: 1 },
  10: { mafia: 3, police: 2, doctor: 1 },
};

const ROLE_NAME = { mafia: '마피아', police: '경찰', doctor: '의사', citizen: '시민' };
const NIGHT_ORDER = ['mafia', 'doctor', 'police'];

const rooms = new Map();

// ───────── 유틸 ─────────
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 10);
}

function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby', // lobby | reveal | night | day | execution | ended
    day: 0,
    players: [],
    chat: [],
    msgSeq: 0,
    timer: null,
    deadline: null,
    night: null,
    votes: {},
    voteLocked: false,
    winner: null,
    event: null,
    eventSeq: 0,
    cleanup: null,
  };
  rooms.set(room.code, room);
  return room;
}

const getPlayer = (room, id) => room.players.find((p) => p.id === id);
const alivePlayers = (room) => room.players.filter((p) => p.alive);
const actorsFor = (room, role) => room.players.filter((p) => p.alive && p.role === role);

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}

function setPhaseTimer(room, seconds, fn) {
  clearTimer(room);
  room.deadline = Date.now() + seconds * 1000;
  room.deadlineTotal = seconds * 1000;
  room.timer = setTimeout(() => {
    room.timer = null;
    fn();
  }, seconds * 1000);
}

function setEvent(room, icon, title, sub = '') {
  room.event = { seq: ++room.eventSeq, icon, title, sub };
}

// ───────── 채팅 ─────────
function canSee(room, p, msg) {
  if (msg.to) return msg.to === p.id;
  if (msg.channel === 'mafia') return p.role === 'mafia' || room.phase === 'ended';
  if (msg.channel === 'dead') return !p.alive || room.phase === 'ended';
  return true; // all, system
}

function pushMessage(room, msg) {
  msg.id = ++room.msgSeq;
  msg.ts = Date.now();
  room.chat.push(msg);
  if (room.chat.length > 300) room.chat.shift();
  for (const p of room.players) {
    if (p.socketId && canSee(room, p, msg)) io.to(p.socketId).emit('chat', msg);
  }
}

function system(room, text, extra = {}) {
  pushMessage(room, { channel: 'system', text, ...extra });
}

function sendHistory(room, p) {
  if (!p.socketId) return;
  io.to(p.socketId).emit('history', room.chat.filter((m) => canSee(room, p, m)));
}

// ───────── 상태 전송 (사람마다 보이는 정보가 다름) ─────────
function buildState(room, me) {
  const revealAll = room.phase === 'ended' || (!me.alive && room.phase !== 'lobby');
  const n = room.night;

  const players = room.players.map((p) => {
    const knows = revealAll || p.id === me.id || (me.role === 'mafia' && p.role === 'mafia');
    return {
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      left: !!p.left,
      role: knows ? p.role : null,
    };
  });

  let night = null;
  if (room.phase === 'night' && n) {
    const myTurn = me.alive && me.role === n.turn;
    let myChoice = null;
    if (me.role === 'mafia') myChoice = n.mafiaPicks[me.id] || null;
    if (me.role === 'doctor') myChoice = n.doctorPicks[me.id] || null;
    if (me.role === 'police') myChoice = n.policeDone[me.id] || null;
    night = {
      myTurn,
      turnRole: myTurn || !me.alive ? n.turn : null,
      myChoice,
      locked: n.locked,
      mafiaPicks: me.role === 'mafia' ? { ...n.mafiaPicks } : null,
    };
  }

  const showVotes = room.phase === 'day' || room.phase === 'execution';

  return {
    code: room.code,
    phase: room.phase,
    day: room.day,
    remaining: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    total: room.deadline ? room.deadlineTotal : null,
    players,
    me: { id: me.id, role: me.role, alive: me.alive, isHost: me.isHost },
    night,
    votes: showVotes ? { ...room.votes } : {},
    voteLocked: room.voteLocked,
    winner: room.winner,
    event: room.event,
    roleTable: ROLE_TABLE,
    config: CONFIG,
  };
}

function sendState(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', buildState(room, p));
  }
}

// ───────── 게임 진행 ─────────
function startGame(room) {
  const n = room.players.length;
  const t = ROLE_TABLE[n];
  const roles = [
    ...Array(t.mafia).fill('mafia'),
    ...Array(t.police).fill('police'),
    ...Array(t.doctor).fill('doctor'),
  ];
  while (roles.length < n) roles.push('citizen');
  shuffle(roles);

  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.left = false;
  });
  room.day = 0;
  room.winner = null;
  room.votes = {};
  room.chat = [];
  room.players.forEach((p) => sendHistory(room, p));

  room.phase = 'reveal';
  const citizens = n - t.mafia - t.police - t.doctor;
  system(room, `🎬 게임 시작! ${n}명 — 마피아 ${t.mafia}, 경찰 ${t.police}, 의사 ${t.doctor}, 시민 ${citizens}`);
  setEvent(room, '🎭', '역할을 확인하세요', '곧 첫 번째 밤이 찾아옵니다');
  setPhaseTimer(room, CONFIG.ROLE_REVEAL_SECONDS, () => startNight(room));
  sendState(room);
}

function startNight(room) {
  room.phase = 'night';
  room.day += 1;
  room.votes = {};
  room.voteLocked = false;
  room.night = { turnIndex: -1, turn: null, locked: false, mafiaPicks: {}, doctorPicks: {}, policeDone: {} };
  system(room, `🌙 ${room.day}일차 밤이 되었습니다. 모두 눈을 감아 주세요.`);
  setEvent(room, '🌙', `${room.day}일차 밤`, '마피아가 움직이기 시작합니다');
  nextNightTurn(room);
}

function nextNightTurn(room) {
  const n = room.night;
  if (!n) return;
  n.locked = false;
  while (true) {
    n.turnIndex++;
    if (n.turnIndex >= NIGHT_ORDER.length) return resolveNight(room);
    const role = NIGHT_ORDER[n.turnIndex];
    const actors = actorsFor(room, role);
    if (actors.length === 0) continue;
    n.turn = role;
    setPhaseTimer(room, CONFIG.NIGHT_SECONDS_PER_PLAYER * actors.length, () => nextNightTurn(room));
    sendState(room);
    return;
  }
}

function checkTurnDone(room) {
  const n = room.night;
  if (!n || n.locked) return;
  const actors = actorsFor(room, n.turn).filter((a) => a.connected);
  if (!actors.length) return; // 접속자가 없으면 시간이 다 될 때까지 기다림

  let done = false;
  if (n.turn === 'mafia') {
    const picks = actors.map((a) => n.mafiaPicks[a.id]);
    done = picks.every(Boolean) && new Set(picks).size === 1;
  } else if (n.turn === 'doctor') {
    done = actors.every((a) => n.doctorPicks[a.id]);
  } else if (n.turn === 'police') {
    done = actors.every((a) => n.policeDone[a.id]);
  }

  if (done) {
    n.locked = true;
    setPhaseTimer(room, 2, () => nextNightTurn(room));
  }
}

function resolveNight(room) {
  const n = room.night;
  room.night = null;

  const counts = {};
  for (const [mafiaId, targetId] of Object.entries(n.mafiaPicks)) {
    const m = getPlayer(room, mafiaId);
    if (m && m.alive) counts[targetId] = (counts[targetId] || 0) + 1;
  }
  let targetId = null;
  const max = Math.max(0, ...Object.values(counts));
  if (max > 0) {
    const top = Object.keys(counts).filter((k) => counts[k] === max);
    targetId = top[Math.floor(Math.random() * top.length)];
  }
  const saved = new Set(Object.values(n.doctorPicks));
  const target = targetId ? getPlayer(room, targetId) : null;

  if (!target || !target.alive) {
    system(room, '☀️ 아침이 밝았습니다. 지난밤에는 아무 일도 일어나지 않았습니다.');
    setEvent(room, '☀️', '조용한 밤이었습니다', '아무도 희생되지 않았어요');
  } else if (saved.has(target.id)) {
    system(room, '☀️ 아침이 밝았습니다. 마피아의 습격이 있었지만 의사가 목숨을 구했습니다! 💉');
    setEvent(room, '💉', '의사가 생명을 구했습니다', '습격당한 사람이 살아남았어요');
  } else {
    target.alive = false;
    system(room, `☀️ 아침이 밝았습니다. 지난밤 ${target.name}님이 마피아에게 희생되었습니다. 🔪`);
    setEvent(room, '🔪', `${target.name}님이 희생되었습니다`, '마피아가 아직 우리 곁에 있습니다');
  }

  if (checkWin(room)) return;
  startDay(room);
}

function startDay(room) {
  room.phase = 'day';
  room.votes = {};
  room.voteLocked = false;
  system(room, `🗣️ ${room.day}일차 낮 — 2분 동안 토론하고, 마피아로 의심되는 사람에게 투표하세요.`);
  setPhaseTimer(room, CONFIG.DAY_SECONDS, () => resolveDay(room));
  sendState(room);
}

function checkAllVoted(room) {
  if (room.phase !== 'day' || room.voteLocked) return;
  const voters = alivePlayers(room).filter((p) => p.connected);
  if (voters.length && voters.every((p) => room.votes[p.id])) {
    room.voteLocked = true;
    system(room, '🗳️ 모두 투표를 마쳤습니다. 잠시 후 결과를 발표합니다.');
    setPhaseTimer(room, 3, () => resolveDay(room));
  }
}

function resolveDay(room) {
  const counts = {};
  for (const [voterId, targetId] of Object.entries(room.votes)) {
    const v = getPlayer(room, voterId);
    if (!v || !v.alive) continue;
    if (targetId !== 'skip') {
      const t = getPlayer(room, targetId);
      if (!t || !t.alive) continue;
    }
    counts[targetId] = (counts[targetId] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  let executed = null;
  if (sorted.length && sorted[0][0] !== 'skip' && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) {
    executed = getPlayer(room, sorted[0][0]);
  }

  room.phase = 'execution';
  room.voteLocked = true;
  if (executed) {
    executed.alive = false;
    system(room, `⚖️ 투표 결과 ${executed.name}님이 ${sorted[0][1]}표로 처형되었습니다.`);
    setEvent(room, '⚖️', `${executed.name}님이 처형되었습니다`, `${sorted[0][1]}표`);
  } else {
    system(room, '⚖️ 표가 갈리거나 기권이 많아 아무도 처형되지 않았습니다.');
    setEvent(room, '⚖️', '아무도 처형되지 않았습니다', '표가 갈렸어요');
  }

  if (checkWin(room)) return;
  setPhaseTimer(room, CONFIG.AFTER_VOTE_SECONDS, () => startNight(room));
  sendState(room);
}

function checkWin(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return false;
  const alive = alivePlayers(room);
  const mafia = alive.filter((p) => p.role === 'mafia').length;
  const others = alive.length - mafia;

  let winner = null;
  if (mafia === 0) winner = 'citizen';
  else if (mafia >= others) winner = 'mafia';
  if (!winner) return false;

  clearTimer(room);
  room.night = null;
  room.phase = 'ended';
  room.winner = winner;
  if (winner === 'mafia') {
    system(room, '🔪 마피아 팀 승리! 마을은 어둠에 잠겼습니다.');
    setEvent(room, '🔪', '마피아 팀 승리', '마을은 어둠에 잠겼습니다');
  } else {
    system(room, '🎉 시민 팀 승리! 마피아를 모두 찾아냈습니다.');
    setEvent(room, '🎉', '시민 팀 승리', '마피아를 모두 찾아냈습니다');
  }
  system(room, '📜 역할 공개 — ' + room.players.map((p) => `${p.name}: ${ROLE_NAME[p.role]}`).join(', '));
  sendState(room);
  return true;
}

function resetToLobby(room) {
  clearTimer(room);
  room.players = room.players.filter((p) => p.connected && !p.left);
  room.players.forEach((p) => {
    p.role = null;
    p.alive = true;
  });
  if (!room.players.some((p) => p.isHost) && room.players[0]) room.players[0].isHost = true;
  room.phase = 'lobby';
  room.day = 0;
  room.night = null;
  room.votes = {};
  room.voteLocked = false;
  room.winner = null;
  room.event = null;
  system(room, '🔁 대기실로 돌아왔습니다. 방장이 새 게임을 시작할 수 있어요.');
  sendState(room);
}

function passHost(room) {
  if (room.players.some((p) => p.isHost && p.connected && !p.left)) return;
  room.players.forEach((p) => (p.isHost = false));
  const next = room.players.find((p) => p.connected && !p.left);
  if (next) {
    next.isHost = true;
    system(room, `👑 ${next.name}님이 새 방장이 되었습니다.`);
  }
}

function removeFromLobby(room, player) {
  room.players = room.players.filter((p) => p !== player);
  if (room.players.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  system(room, `🚪 ${player.name}님이 나갔습니다.`);
  passHost(room);
  sendState(room);
}

function afterRosterChange(room) {
  if (checkWin(room)) return;
  if (room.phase === 'night') checkTurnDone(room);
  if (room.phase === 'day') checkAllVoted(room);
  sendState(room);
}

function ctxOf(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return null;
  const player = getPlayer(room, socket.data.pid);
  if (!player) return null;
  return { room, player };
}

// ───────── 소켓 이벤트 ─────────
io.on('connection', (socket) => {
  function attach(room, player) {
    player.socketId = socket.id;
    player.connected = true;
    if (player.removeTimer) {
      clearTimeout(player.removeTimer);
      player.removeTimer = null;
    }
    socket.data.code = room.code;
    socket.data.pid = player.id;
    if (room.cleanup) {
      clearTimeout(room.cleanup);
      room.cleanup = null;
    }
    socket.emit('joined', { code: room.code, name: player.name });
    sendHistory(room, player);
  }

  function validPid(pid) {
    return typeof pid === 'string' && pid.length > 0 && pid.length <= 64;
  }

  socket.on('create', ({ name, pid } = {}) => {
    name = cleanName(name);
    if (!name) return socket.emit('errorMsg', '닉네임을 입력해 주세요.');
    if (!validPid(pid)) return socket.emit('errorMsg', '새로고침 후 다시 시도해 주세요.');
    const room = createRoom();
    const player = { id: pid, name, socketId: null, connected: true, alive: true, role: null, isHost: true, lastChat: 0 };
    room.players.push(player);
    attach(room, player);
    system(room, `🏠 ${name}님이 방을 만들었습니다. 방 코드 ${room.code}를 친구들에게 알려 주세요.`);
    sendState(room);
  });

  socket.on('join', ({ code, name, pid } = {}) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('errorMsg', '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', { noRoom: true });
    if (!validPid(pid)) return socket.emit('errorMsg', '새로고침 후 다시 시도해 주세요.');

    const existing = getPlayer(room, pid);
    if (existing && !existing.left) {
      // 재접속
      if (existing.socketId && existing.socketId !== socket.id) {
        io.to(existing.socketId).emit('kicked', '다른 탭에서 접속해서 이 화면은 종료됐어요.');
      }
      attach(room, existing);
      if (room.phase !== 'lobby') system(room, `🔌 ${existing.name}님이 다시 접속했습니다.`);
      passHost(room);
      afterRosterChange(room);
      return;
    }

    if (room.phase !== 'lobby') return socket.emit('errorMsg', '이미 게임이 진행 중이에요. 끝나면 다시 들어와 주세요.');
    if (room.players.length >= CONFIG.MAX_PLAYERS) return socket.emit('errorMsg', `방이 가득 찼어요. (최대 ${CONFIG.MAX_PLAYERS}명)`);
    name = cleanName(name);
    if (!name) return socket.emit('errorMsg', '닉네임을 입력해 주세요.');
    if (room.players.some((p) => p.name === name)) return socket.emit('errorMsg', '이미 사용 중인 닉네임이에요.');

    const player = { id: pid, name, socketId: null, connected: true, alive: true, role: null, isHost: false, lastChat: 0 };
    room.players.push(player);
    attach(room, player);
    system(room, `👋 ${name}님이 입장했습니다. (${room.players.length}/${CONFIG.MAX_PLAYERS})`);
    sendState(room);
  });

  socket.on('start', () => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (!player.isHost || room.phase !== 'lobby') return;
    const n = room.players.length;
    if (n < CONFIG.MIN_PLAYERS) return socket.emit('toast', `최소 ${CONFIG.MIN_PLAYERS}명이 있어야 시작할 수 있어요.`);
    if (n > CONFIG.MAX_PLAYERS) return socket.emit('toast', `최대 ${CONFIG.MAX_PLAYERS}명까지만 가능해요.`);
    startGame(room);
  });

  socket.on('restart', () => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (!player.isHost || room.phase !== 'ended') return;
    resetToLobby(room);
  });

  socket.on('nightAction', (targetId) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    const n = room.night;
    if (room.phase !== 'night' || !n || n.locked || !player.alive || player.role !== n.turn) return;
    const target = getPlayer(room, targetId);
    if (!target || !target.alive) return;

    if (player.role === 'mafia') {
      if (target.role === 'mafia') return;
      n.mafiaPicks[player.id] = target.id;
    } else if (player.role === 'doctor') {
      n.doctorPicks[player.id] = target.id;
    } else if (player.role === 'police') {
      if (n.policeDone[player.id] || target.id === player.id) return;
      n.policeDone[player.id] = target.id;
      const isMafia = target.role === 'mafia';
      pushMessage(room, {
        channel: 'system',
        to: player.id,
        private: true,
        text: isMafia
          ? `🕵️ 조사 결과: ${target.name}님은 마피아입니다!`
          : `🕵️ 조사 결과: ${target.name}님은 마피아가 아닙니다.`,
      });
    }
    checkTurnDone(room);
    sendState(room);
  });

  socket.on('vote', (targetId) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.phase !== 'day' || room.voteLocked || !player.alive) return;

    if (room.votes[player.id] === targetId) {
      delete room.votes[player.id]; // 같은 대상 다시 누르면 취소
    } else if (targetId === 'skip') {
      room.votes[player.id] = 'skip';
    } else {
      const t = getPlayer(room, targetId);
      if (!t || !t.alive || t.id === player.id) return;
      room.votes[player.id] = t.id;
    }
    checkAllVoted(room);
    sendState(room);
  });

  socket.on('chat', (text) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    text = String(text || '').trim().slice(0, 300);
    if (!text) return;
    const now = Date.now();
    if (now - player.lastChat < 350) return;
    player.lastChat = now;

    let channel = 'all';
    if (room.phase === 'lobby' || room.phase === 'ended') channel = 'all';
    else if (!player.alive) channel = 'dead';
    else if (room.phase === 'night') {
      if (player.role !== 'mafia') return socket.emit('toast', '밤에는 조용히… 마피아만 대화할 수 있어요 🤫');
      channel = 'mafia';
    } else if (room.phase === 'reveal') {
      return socket.emit('toast', '역할을 확인하는 중이에요. 잠시만 기다려 주세요.');
    }
    pushMessage(room, { channel, from: player.name, fromId: player.id, text });
  });

  socket.on('leave', () => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    socket.data.code = null;
    socket.data.pid = null;
    player.socketId = null;
    player.connected = false;

    if (room.phase === 'lobby') return removeFromLobby(room, player);

    player.left = true;
    player.isHost = false;
    if (player.alive && room.phase !== 'ended') {
      player.alive = false;
      delete room.votes[player.id];
      system(room, `🚪 ${player.name}님이 게임을 떠났습니다. (사망 처리)`);
    } else {
      system(room, `🚪 ${player.name}님이 나갔습니다.`);
    }
    passHost(room);
    if (room.players.every((p) => !p.connected)) {
      clearTimer(room);
      rooms.delete(room.code);
      return;
    }
    afterRosterChange(room);
  });

  socket.on('disconnect', () => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (player.socketId !== socket.id) return;
    player.socketId = null;
    player.connected = false;

    if (room.phase === 'lobby') {
      // 새로고침 대비: 8초 안에 돌아오면 자리 유지
      sendState(room);
      player.removeTimer = setTimeout(() => {
        player.removeTimer = null;
        if (!player.connected && room.phase === 'lobby' && rooms.get(room.code) === room) removeFromLobby(room, player);
      }, 8000);
      return;
    }

    system(room, `📴 ${player.name}님의 연결이 끊겼습니다.`);
    passHost(room);
    if (room.players.every((p) => !p.connected)) {
      // 모두 나가면 5분 뒤 방 정리
      room.cleanup = setTimeout(() => {
        clearTimer(room);
        rooms.delete(room.code);
      }, 5 * 60 * 1000);
    }
    afterRosterChange(room);
  });
});

server.listen(PORT, () => {
  console.log(`🌙 마피아 서버 실행 중 → http://localhost:${PORT}`);
});
