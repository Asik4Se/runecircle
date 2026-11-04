'use strict';
/* =====================================================================
   ブロブアリーナ オンラインサーバー（ゲーム選択サーバー ../../server.js から読み込まれる）
   ・画面は public/ のファイルを /blob-arena/ で配信
   ・通信は WebSocket（/blob-arena/ws）。試合の計算はすべてサーバーで行う
   ・ゲームのルール本体は public/core.js（ブラウザのひとり練習と共通）
   ===================================================================== */
const crypto = require('crypto');
const { Game } = require('./public/core.js');

const TICK = 1 / 20;
const MAX_ROOMS = Number(process.env.BLOB_MAX_ROOMS) || 200;

const rooms = new Map();
const clients = new Map(); // id -> { conn, room, name, vw, vh }

const send = (c, t, d) => { if (c && c.conn.open) c.conn.send(JSON.stringify({ t, d })); };

function newCode() {
  let code;
  do { code = String(1000 + crypto.randomInt(9000)); } while (rooms.has(code));
  return code;
}
function roomInfo(room) {
  return {
    code: room.code, hostId: room.hostId, state: room.state, matchTime: room.matchTime,
    members: [...room.members].map((id) => ({ id, name: clients.get(id).name })),
  };
}
function broadcast(room, t, d) { for (const id of room.members) send(clients.get(id), t, d); }
function broadcastRoom(room) { broadcast(room, 'room', roomInfo(room)); }

function startMatch(room) {
  stopLoop(room);
  room.game = new Game({ matchTime: room.matchTime });
  for (const id of room.members) room.game.addPlayer(id, clients.get(id).name);
  room.state = 'playing';
  broadcastRoom(room);
  room.loop = setInterval(() => tick(room), TICK * 1000);
}
function stopLoop(room) { if (room.loop) clearInterval(room.loop); room.loop = null; }

function tick(room) {
  const g = room.game;
  if (!g) return;
  try {
    g.step(TICK);
  } catch (e) {
    console.error('[ブロブアリーナ] 試合の計算でエラー', e && e.stack || e);
    return;
  }
  for (const id of room.members) {
    const c = clients.get(id);
    if (!c || !c.conn.open) continue;
    if (c.conn.backlog > 512 * 1024) continue; // 回線が詰まっている人には今回分を送らない
    send(c, 'snap', g.view(id, c.vw, c.vh));
  }
  if (g.ended) {
    stopLoop(room);
    room.state = 'result';
    broadcast(room, 'result', g.result);
    broadcastRoom(room);
  }
}

function leave(id) {
  const c = clients.get(id);
  if (!c || !c.room) return;
  const room = rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.members.delete(id);
  if (room.game) room.game.removePlayer(id);
  if (!room.members.size) { stopLoop(room); rooms.delete(room.code); return; }
  if (room.hostId === id) room.hostId = room.members.values().next().value;
  broadcastRoom(room);
}
function joinRoom(id, room, name) {
  leave(id);
  const c = clients.get(id);
  c.name = cleanName(name);
  c.room = room.code;
  room.members.add(id);
  if (room.state === 'playing' && room.game) room.game.addPlayer(id, c.name);
  broadcastRoom(room);
}
function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || 'プレイヤー';
}

const handlers = {
  create(id, d) {
    if (rooms.size >= MAX_ROOMS) { send(clients.get(id), 'joinError', 'いまは部屋がいっぱいです。しばらくしてからもう一度お試しください'); return; }
    const room = { code: newCode(), hostId: id, members: new Set(), state: 'lobby', matchTime: 300, game: null, loop: null };
    rooms.set(room.code, room);
    joinRoom(id, room, d && d.name);
  },
  join(id, d) {
    const room = rooms.get(String((d && d.code) || '').trim());
    if (!room) { send(clients.get(id), 'joinError', '部屋が見つかりません。部屋コードを確かめてください'); return; }
    joinRoom(id, room, d.name);
  },
  settings(id, d, room) {
    if (!room || room.hostId !== id || room.state === 'playing') return;
    const t = Math.round(Number(d && d.matchTime));
    if (t >= 60 && t <= 600) room.matchTime = t;
    broadcastRoom(room);
  },
  start(id, d, room) {
    if (!room || room.hostId !== id || room.state === 'playing') return;
    startMatch(room);
  },
  toLobby(id, d, room) {
    if (!room || room.hostId !== id) return;
    stopLoop(room); room.game = null; room.state = 'lobby';
    broadcastRoom(room);
  },
  viewport(id, d) {
    const c = clients.get(id);
    c.vw = Math.max(320, Math.min(3840, Number(d && d.w) || 1280));
    c.vh = Math.max(320, Math.min(2160, Number(d && d.h) || 720));
  },
  input(id, d, room) { if (room && room.game && d) room.game.setInput(id, Number(d.dx), Number(d.dy)); },
  split(id, d, room) { if (room && room.game) room.game.split(id); },
  eject(id, d, room) { if (room && room.game) room.game.setEject(id, !!d); },
  leave(id) { leave(id); },
};

function onConnection(conn) {
  const id = crypto.randomBytes(6).toString('hex');
  clients.set(id, { conn, room: null, name: '', vw: 1280, vh: 720 });
  send(clients.get(id), 'hello', { id });
  conn.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    const h = msg && Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (!h) return;
    const c = clients.get(id);
    try { h(id, msg.d, c && c.room ? rooms.get(c.room) : null); } catch (e) { console.error('[ブロブアリーナ]', e && e.stack || e); }
  });
  conn.on('close', () => { leave(id); clients.delete(id); });
}

module.exports = {
  meta: {
    id: 'blob-arena',
    title: 'ブロブアリーナ',
    tagline: '食べて、大きくなって、逆転しろ',
    description: 'エサやNPCを食べて大きくなる捕食バトル。人数は無制限、5分間の試合で終了時のスコアが一番高い人の勝ち。',
    players: '1人〜（人数無制限）',
    glyph: '●',
    colors: ['#0a1a2f', '#13806b', '#5cf2c5'],
    order: 2,
  },
  ws: { onConnection },
};
