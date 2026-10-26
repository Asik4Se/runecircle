'use strict';
/* =====================================================================
   ルーンサークル オンラインサーバー
   ・Node.js だけで動きます（追加のインストールは不要）
   ・部屋とゲームの進行（階・行き先の投票・ルーレット）はこのサーバーが持ちます
   ・戦闘の中身はブラウザ側で計算し、「今動いている人」だけが更新を送れます
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;   // 誰も触らない部屋を消すまでの時間
const ONLINE_MS = 9000;                   // これより長く応答がない人は「切断」扱い
const MAX_PLAYERS = 4;
// 公開サイトとして動かしているか（Render・Railway・Fly.io などは自動で判定。ほかは RC_HOSTED=1 を設定）
const HOSTED = process.env.RC_HOSTED === '1' || !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.KOYEB_APP_NAME);
const MAX_ROOMS = Number(process.env.RC_MAX_ROOMS) || 500;  // 同時に作れる部屋の上限
const SPIN_MS = Number(process.env.RC_SPIN_MS) || 4200;    // ルーレットが回っている時間
const DECIDE_MS = Number(process.env.RC_DECIDE_MS) || 1300; // 全員一致のときの待ち時間
const ACTS = [12, 14, 14];                // 各幕の階数
const CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INDEX = path.join(__dirname, 'index.html');
const SAVE_DIR = path.join(__dirname, 'save');
const SAVE_FILE = path.join(SAVE_DIR, 'progress.json');

const rooms = new Map();

/* ---------------- 共通 ---------------- */
const now = () => Date.now();
const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
function newCode() {
  for (let k = 0; k < 200; k++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CH[crypto.randomInt(CODE_CH.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('部屋コードを作れませんでした');
}
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
const CHARS = ['apprentice', 'witch', 'ranger'];
const cleanChar = c => (CHARS.includes(c) ? c : 'apprentice');
function touch(room) { room.updatedAt = now(); room.rev++; }
function isOnline(p) { return !p.left && now() - p.lastSeen < ONLINE_MS; }
function livePlayers(room) { return room.players.filter(p => p.inGame && isOnline(p)); }

/* 行き先の候補（ブラウザ版と同じ決まり。各幕の1〜3階は精鋭を出さない） */
function genOpts(act, floor) {
  const len = ACTS[act];
  if (floor === len - 1) return ['boss'];
  if (floor === 0) return ['battle'];
  if (floor === len - 2) return ['camp'];
  if (floor === Math.floor(len / 2)) return ['treasure'];
  const w = { battle: 45, event: 18, camp: 12, elite: floor >= 3 ? 10 : 0, shop: 10 };
  const n = Math.random() < 0.5 ? 2 : 3;
  const out = [];
  for (let g = 0; out.length < n && g < 60; g++) {
    let tot = 0; for (const k in w) tot += w[k];
    let x = Math.random() * tot, pick = 'battle';
    for (const k in w) { x -= w[k]; if (x < 0) { pick = k; break; } }
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}
function resetVote(room) { room.vote = { votes: {}, result: null, tally: null, order: null, spin: false, target: 0, at: 0 }; }

/* ホストが抜けたら、次につながっている人に引き継ぐ */
function ensureHost(room) {
  const h = room.players.find(p => p.id === room.hostId);
  if (h && isOnline(h)) return;
  const pool = room.phase === 'game' ? room.players.filter(p => p.inGame) : room.players;
  const next = pool.find(isOnline);
  if (next && next.id !== room.hostId) { room.hostId = next.id; touch(room); }
}

/* 全員が投票したら行き先を決める（割れたら票数に比例したルーレット） */
function tryResolveVote(room) {
  if (room.phase !== 'game' || room.stage !== 'map' || room.vote.result) return;
  const live = livePlayers(room);
  if (!live.length || !live.every(p => room.vote.votes[p.id] !== undefined)) return;
  const tally = {};
  for (const p of live) { const o = room.vote.votes[p.id]; tally[o] = (tally[o] || 0) + 1; }
  const order = room.opts.filter(o => tally[o]);
  const total = live.length;
  let x = Math.random() * total, result = order[0];
  for (const o of order) { x -= tally[o]; if (x < 0) { result = o; break; } }
  let start = 0, target = 0;
  for (const o of order) {
    const span = 360 * tally[o] / total;
    if (o === result) target = start + span * (0.15 + 0.7 * Math.random());
    start += span;
  }
  const spin = order.length > 1;
  Object.assign(room.vote, { result, tally, order, spin, target, at: now() });
  const key = room.act + '-' + room.floor;
  setTimeout(() => {
    if (room.stage === 'map' && room.vote.result === result && room.act + '-' + room.floor === key) {
      room.stage = 'node'; room.node = result; room.nodeKey = key; room.cs = null;
      room.evSeed = Math.floor(Math.random() * 1e9); // 遺跡のイベントを全員でそろえるため
      touch(room);
    }
  }, spin ? SPIN_MS : DECIDE_MS);
  touch(room);
}

/* 全員が今の階を終えたら次の階へ */
function tryAdvance(room) {
  if (room.phase !== 'game' || room.stage !== 'node') return;
  const live = livePlayers(room);
  if (!live.length || !live.every(p => p.done === room.nodeKey)) return;
  let act = room.act, floor = room.floor + 1;
  if (floor >= ACTS[act]) { act++; floor = 0; }
  if (act > 2) { room.stage = 'end'; room.result = 'win'; touch(room); return; }
  room.act = act; room.floor = floor; room.opts = genOpts(act, floor);
  room.stage = 'map'; room.node = null; room.nodeKey = null; room.cs = null; resetVote(room);
  touch(room);
}

function publicRoom(room, viewerId) {
  return {
    code: room.code, phase: room.phase, stage: room.stage, hostId: room.hostId, curse: room.curse,
    act: room.act, floor: room.floor, opts: room.opts, node: room.node, nodeKey: room.nodeKey, evSeed: room.evSeed || 0, prog: room.prog || null, bossSeed: room.bossSeed || 0,
    vote: room.vote, cs: room.cs, result: room.result, rev: room.rev, serverNow: now(), you: viewerId || null,
    players: room.players.filter(p => !p.left || p.inGame).map(p => ({
      id: p.id, name: p.name, char: p.char, ready: p.ready, hp: p.hp, max: p.max, lantern: p.lantern,
      done: p.done, inGame: p.inGame, online: isOnline(p), left: p.left
    }))
  };
}

/* ---------------- 通信 ---------------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 128 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function auth(room, body) {
  const p = room.players.find(x => x.id === body.playerId);
  if (!p || p.token !== body.token || p.left) return null;
  p.lastSeen = now();
  return p;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/ping') return send(res, 200, { app: 'runecircle', ok: true, hosted: HOSTED });

  if (url.pathname === '/api/room' && req.method === 'POST') {
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (!name) return send(res, 400, { error: '名前を入力してください' });
    if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'いまは部屋がいっぱいです。しばらくしてからもう一度お試しください' });
    const code = newCode();
    const p = { id: newId(), token: newToken(), name, char: cleanChar(body.char), ready: false, hp: 0, max: 0, lantern: false, done: null, inGame: false, left: false, lastSeen: now() };
    const room = { code, phase: 'lobby', stage: null, hostId: p.id, curse: 0, act: 0, floor: 0, opts: [], node: null, nodeKey: null, cs: null, result: null, players: [p], createdAt: now(), updatedAt: now(), rev: 0 };
    resetVote(room);
    rooms.set(code, room);
    return send(res, 200, { code, playerId: p.id, token: p.token });
  }

  const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{4})(?:\/(join|me|settings|start|vote|done|cs|finish|reset|leave))?$/);
  if (!m) return send(res, 404, { error: '見つかりません' });
  const room = rooms.get(m[1].toUpperCase());
  if (!room) return send(res, 404, { error: 'その部屋は見つかりません。部屋コードを確かめてください' });
  const act = m[2];

  if (!act && req.method === 'GET') {
    const pid = url.searchParams.get('playerId');
    const p = room.players.find(x => x.id === pid);
    if (p && !p.left) p.lastSeen = now();
    ensureHost(room); tryResolveVote(room); tryAdvance(room);
    return send(res, 200, { room: publicRoom(room, p ? p.id : null) });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'この操作はできません' });
  const body = await readBody(req);

  if (act === 'join') {
    const name = cleanName(body.name);
    if (!name) return send(res, 400, { error: '名前を入力してください' });
    if (room.phase !== 'lobby') return send(res, 409, { error: 'この部屋はもう始まっています' });
    if (room.players.filter(p => !p.left).length >= MAX_PLAYERS) return send(res, 409, { error: 'この部屋は満員です（4人）' });
    const p = { id: newId(), token: newToken(), name, char: cleanChar(body.char), ready: false, hp: 0, max: 0, lantern: false, done: null, inGame: false, left: false, lastSeen: now() };
    room.players.push(p); touch(room);
    return send(res, 200, { code: room.code, playerId: p.id, token: p.token });
  }

  const me = auth(room, body);
  if (!me) return send(res, 403, { error: 'この部屋の参加者として確認できませんでした' });
  const isHost = me.id === room.hostId;

  switch (act) {
    case 'me': {
      const q = body.patch || {};
      if (room.phase === 'lobby') {
        if (q.char !== undefined) me.char = cleanChar(q.char);
        if (q.ready !== undefined) me.ready = !!q.ready;
      }
      if (q.hp !== undefined) me.hp = Math.max(0, Math.min(9999, Number(q.hp) || 0));
      if (q.max !== undefined) me.max = Math.max(1, Math.min(9999, Number(q.max) || 1));
      if (q.lantern !== undefined) me.lantern = !!q.lantern;
      // ホストの進行度（参加者のキャラ選択をホストに合わせる）
      if (isHost && q.prog && typeof q.prog === 'object') room.prog = { reached2: !!q.prog.reached2, clears: Math.max(0, Math.min(99999, Math.floor(Number(q.prog.clears) || 0))) };
      touch(room);
      return send(res, 200, { ok: true });
    }
    case 'settings': {
      if (!isHost) return send(res, 403, { error: 'ホストだけが変更できます' });
      if (room.phase !== 'lobby') return send(res, 409, { error: '始まってからは変更できません' });
      room.curse = Math.max(0, Math.min(10, Math.floor(Number(body.curse) || 0)));
      touch(room);
      return send(res, 200, { ok: true });
    }
    case 'start': {
      if (!isHost) return send(res, 403, { error: 'ホストだけが始められます' });
      if (room.phase !== 'lobby') return send(res, 409, { error: 'もう始まっています' });
      const ps = room.players.filter(p => !p.left && isOnline(p));
      if (ps.some(p => p.id !== me.id && !p.ready)) return send(res, 409, { error: '準備ができていない人がいます' });
      room.players.forEach(p => { p.inGame = ps.includes(p); p.done = null; });
      Object.assign(room, { phase: 'game', stage: 'map', act: 0, floor: 0, opts: genOpts(0, 0), node: null, nodeKey: null, cs: null, result: null, bossSeed: Math.floor(Math.random() * 1e9) });
      resetVote(room); touch(room);
      return send(res, 200, { ok: true });
    }
    case 'vote': {
      if (room.phase !== 'game' || room.stage !== 'map' || room.vote.result) return send(res, 409, { error: '今は投票できません' });
      if (!me.inGame) return send(res, 403, { error: '参加者ではありません' });
      if (!room.opts.includes(body.opt)) return send(res, 400, { error: 'その行き先はありません' });
      room.vote.votes[me.id] = body.opt; touch(room);
      tryResolveVote(room);
      return send(res, 200, { ok: true });
    }
    case 'done': {
      if (room.phase !== 'game' || room.stage !== 'node' || body.key !== room.nodeKey) return send(res, 409, { error: '今の階ではありません' });
      me.done = room.nodeKey; touch(room);
      tryAdvance(room);
      return send(res, 200, { ok: true });
    }
    case 'cs': {
      const cs = body.cs;
      if (room.phase !== 'game' || room.stage !== 'node') return send(res, 409, { error: '戦闘中ではありません' });
      if (!cs || typeof cs !== 'object' || typeof cs.id !== 'string' || typeof cs.seq !== 'number' || cs.nodeKey !== room.nodeKey) return send(res, 400, { error: '戦闘の状態が正しくありません' });
      if (JSON.stringify(cs).length > 48 * 1024) return send(res, 413, { error: '大きすぎます' });
      const cur = room.cs;
      if (!cur || cur.id !== cs.id) {
        if (!isHost) return send(res, 403, { error: '戦闘を始められるのはホストだけです' });
        if (cur && cur.nodeKey === room.nodeKey) return send(res, 409, { error: 'この階の戦闘はもう始まっています' });
      } else {
        if (cur.auth !== me.id && !isHost) return send(res, 403, { error: '今はあなたの番ではありません' });
        if (!(cs.seq > cur.seq)) return send(res, 409, { error: '古い状態です' });
      }
      room.cs = cs; touch(room);
      return send(res, 200, { ok: true });
    }
    case 'finish': {
      if (room.phase === 'game' && room.stage !== 'end') { room.stage = 'end'; room.result = body.win ? 'win' : 'lose'; touch(room); }
      return send(res, 200, { ok: true });
    }
    case 'reset': {
      if (!isHost) return send(res, 403, { error: 'ホストだけが操作できます' });
      if (room.phase === 'game' && room.stage !== 'end') return send(res, 409, { error: 'ゲームの途中です' });
      room.players = room.players.filter(p => !p.left);
      room.players.forEach(p => { p.inGame = false; p.ready = false; p.done = null; });
      Object.assign(room, { phase: 'lobby', stage: null, act: 0, floor: 0, opts: [], node: null, nodeKey: null, cs: null, result: null });
      resetVote(room); touch(room);
      return send(res, 200, { ok: true });
    }
    case 'leave': {
      me.left = true; me.lastSeen = 0;
      if (room.phase === 'lobby') room.players = room.players.filter(p => p !== me);
      ensureHost(room); touch(room);
      if (!room.players.some(p => !p.left)) rooms.delete(room.code);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: '見つかりません' });
}

/* ---------- 進行度のセーブ（このフォルダの save/progress.json） ----------
   このパソコンのブラウザからだけ読み書きできる。
   ほかの人のURL（同じWi-Fi・インターネット）で遊んでいるときも、
   自分の start.bat を起動しておけば、ゲームの画面がここへ保存しにくる。 */
function isLocalRequest(req) {
  const ra = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return false;
  // トンネル（cloudflared）経由の通信もこのパソコンから届くので、ヘッダーで見分ける
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
function allowedOrigin(o) {
  if (!o) return null;
  if (o === 'null') return o; // index.html を直接開いたとき
  try {
    const u = new URL(o), h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return o;
    if (/\.trycloudflare\.com$/.test(h)) return o;
    if (/^(10|127)\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h) || /^169\.254\.\d+\.\d+$/.test(h)) return o;
  } catch (e) {}
  return null;
}
async function handleSave(req, res) {
  const origin = allowedOrigin(req.headers.origin);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  } else if (req.headers.origin) {
    return send(res, 403, { error: 'このページからは保存できません' });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!isLocalRequest(req)) return send(res, 403, { error: '進行度の保存は、このパソコンからだけ使えます' });
  if (req.method === 'GET') {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (e) { data = null; }
    return send(res, 200, { app: 'runecircle-save', data });
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    const d = body && body.data;
    if (!d || typeof d !== 'object' || !d.meta || typeof d.meta !== 'object') return send(res, 400, { error: '保存する内容が正しくありません' });
    const out = JSON.stringify({ meta: d.meta, nick: String(d.nick || '').slice(0, 10), savedAt: now() });
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    try { if (fs.existsSync(SAVE_FILE)) fs.copyFileSync(SAVE_FILE, path.join(SAVE_DIR, 'progress.bak.json')); } catch (e) {}
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFileSync(tmp, out); fs.renameSync(tmp, SAVE_FILE);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'この操作はできません' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/save') return await handleSave(req, res);
    if (url.pathname.startsWith('/api/')) {
      // 自分のフォルダのゲーム（localhost）から、ほかの人の部屋に参加できるようにする
      const origin = allowedOrigin(req.headers.origin);
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return await handleApi(req, res, url);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return fs.readFile(INDEX, (err, data) => {
        if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('index.html が見つかりません'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        // スマホで正しい幅で表示されるよう、文書の頭（文字コード・画面幅の指定）を付けて返す
        let html = data.toString('utf8');
        if (!/^\s*<!doctype/i.test(html)) html = '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#15131f">\n' + html;
        res.end(html);
      });
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('見つかりません');
  } catch (e) {
    if (!res.headersSent) send(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 500, { error: '処理できませんでした' });
    if (e.message !== 'bad json' && e.message !== 'too large') console.error('[エラー]', e && e.stack || e);
  }
});

/* 放置された部屋の片付け */
setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) if (t - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
}, 5 * 60 * 1000).unref();

process.on('uncaughtException', e => console.error('[エラー]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[エラー]', e && e.stack || e));

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function openBrowser(u) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* 開けなくても問題なし */ }
}
function startTunnel() {
  const cmd = process.env.CLOUDFLARED_PATH || (process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  console.log('  インターネット用のURLを準備しています（10〜30秒ほどかかります）...');
  let shown = false;
  let cf;
  try { cf = spawn(cmd, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return console.log('  [エラー] cloudflared が見つかりません。start-online から起動し直してください。'); }
  const onData = d => {
    // cloudflared は失敗時に api.trycloudflare.com をログに出すので、それは除外する
    const mm = String(d).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (mm && !shown) {
      shown = true;
      console.log('');
      console.log('  ##################################################');
      console.log('  #');
      console.log('  #   インターネット用のURLができました');
      console.log('  #');
      console.log('  #   ' + mm[0]);
      console.log('  #');
      console.log('  #   ↑これを、一緒に遊ぶ人に そのまま 送ってください');
      console.log('  #   （毎回ちがうURLになります）');
      console.log('  #');
      console.log('  ##################################################');
      console.log('');
    }
  };
  cf.stdout.on('data', onData); cf.stderr.on('data', onData);
  cf.on('error', e => {
    if (e.code === 'ENOENT') console.log('  [エラー] cloudflared が見つかりません。start-online から起動すると自動で用意されます。');
    else console.log('  [エラー] cloudflared を起動できませんでした: ' + e.message);
  });
  cf.on('exit', c => { if (!shown) console.log('  [注意] インターネット用のURLを作れませんでした（同じWi-Fiの人とは遊べます）'); });
  process.on('exit', () => { try { cf.kill(); } catch (e) {} });
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  [エラー] ポート ${PORT} はすでに使われています。`);
    console.log('  サーバーがもう起動していないか確認してください（二重に起動していませんか？）。');
    console.log('');
    process.exit(1);
  }
  console.error('[エラー]', e);
  process.exit(1);
});
server.listen(PORT, () => {
  const local = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ==================================================');
  console.log('    ルーンサークル サーバー起動中');
  console.log('  ==================================================');
  console.log('');
  console.log(`    自分の端末から:      ${local}`);
  for (const ip of lanAddresses()) console.log(`    同じWi-Fiの人から:   http://${ip}:${PORT}   ← これを配る`);
  console.log('');
  console.log('    進行度（解放・戦績・図鑑）は save/progress.json にも保存されます。');
  console.log('    ほかの人のURLで遊ぶときも、このウィンドウを開いたままにしておくと保存されます。');
  console.log('');
  console.log('    このウィンドウを閉じるとサーバーが止まります。');
  console.log('');
  if (process.env.OPEN_BROWSER === '1') openBrowser(local);
  if (process.env.TUNNEL === '1') startTunnel();
});
