'use strict';
/* =====================================================================
   ゲーム選択サーバー
   ・Node.js だけで動きます（追加のインストールは不要）
   ・games/<フォルダ>/game.js があるゲームを自動で読み込み、トップページに並べます
   ・ゲームの追加方法は README.md の「ゲームを追加するとき」を見てください
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ws = require('./lib/ws.js');

const PORT = Number(process.env.PORT) || 8080;
const GAMES_DIR = path.join(__dirname, 'games');
const LAUNCHER = path.join(__dirname, 'launcher', 'index.html');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

process.on('uncaughtException', e => console.error('[エラー]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[エラー]', e && e.stack || e));

/* ---------------- ゲームの読み込み ---------------- */
function loadGames() {
  const list = [];
  let dirs = [];
  try { dirs = fs.readdirSync(GAMES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (e) { /* games フォルダがない */ }
  for (const d of dirs) {
    const file = path.join(GAMES_DIR, d.name, 'game.js');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = require(file);
      const meta = mod.meta || {};
      if (meta.id !== d.name) { console.error(`[注意] games/${d.name}/game.js の meta.id は "${d.name}" にしてください（スキップしました）`); continue; }
      if (meta.hidden) continue;
      list.push({ id: d.name, mod, meta, publicDir: path.join(GAMES_DIR, d.name, 'public') });
    } catch (e) {
      console.error(`[エラー] games/${d.name}/game.js を読み込めませんでした`, e && e.stack || e);
    }
  }
  list.sort((a, b) => (a.meta.order ?? 999) - (b.meta.order ?? 999) || String(a.meta.title).localeCompare(String(b.meta.title), 'ja'));
  return list;
}
const games = loadGames();
const gameById = new Map(games.map(g => [g.id, g]));

// トップページに渡す一覧（表示に使う項目だけ）
const gameList = games.map(({ id, meta }) => ({
  id, path: `/${id}/`,
  title: meta.title || id, tagline: meta.tagline || '', description: meta.description || '',
  players: meta.players || '', glyph: meta.glyph || '', colors: Array.isArray(meta.colors) ? meta.colors.slice(0, 3) : [],
}));

/* ---------------- 配信 ---------------- */
function sendFile(res, file, extraHeaders) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('見つかりません'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...extraHeaders });
    res.end(data);
  });
}
function serveStatic(res, root, rel) {
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }

  // 各ゲーム自身の処理（APIや特別なページ）を先に試す
  for (const g of games) {
    if (typeof g.mod.handle !== 'function') continue;
    try {
      if (await g.mod.handle(req, res, url)) return;
    } catch (e) {
      console.error(`[エラー] ${g.id}`, e && e.stack || e);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('処理できませんでした'); }
      return;
    }
  }

  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (pathname === '/games.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(gameList));
  }
  if (pathname === '/' || pathname === '/index.html') {
    // 以前トップページだったゲームへのリンク（例：/?server=…）は、そのゲームへ案内する
    for (const g of games) {
      const keys = g.meta.legacyQuery || [];
      if (keys.some(k => url.searchParams.has(k))) return redirect(res, `/${g.id}/${url.search}`);
    }
    return sendFile(res, LAUNCHER);
  }

  const m = pathname.match(/^\/([a-z0-9-]+)(\/.*)?$/);
  const g = m && gameById.get(m[1]);
  if (!g) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('見つかりません'); }
  if (!m[2]) return redirect(res, `/${g.id}/${url.search}`);
  return serveStatic(res, g.publicDir, m[2].slice(1));
});

// WebSocket：/<ゲーム>/ws を、そのゲームの ws.onConnection に渡す
server.on('upgrade', (req, socket) => {
  socket.on('error', () => {});
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* noop */ }
  const m = pathname.match(/^\/([a-z0-9-]+)\/ws$/);
  const g = m && gameById.get(m[1]);
  if (!g || !g.mod.ws || typeof g.mod.ws.onConnection !== 'function') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const conn = ws.accept(req, socket);
  if (conn) g.mod.ws.onConnection(conn, req);
});

/* ---------------- 起動 ---------------- */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}
function openBrowser(u) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* 開けなくても問題なし */ }
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
  console.log('    ゲームサーバー起動中');
  console.log('  ==================================================');
  console.log('');
  console.log(`    自分の端末から:      ${local}`);
  for (const ip of lanAddresses()) console.log(`    同じWi-Fiの人から:   http://${ip}:${PORT}   ← これを配る`);
  console.log('');
  console.log(`    遊べるゲーム: ${games.map(g => g.meta.title).join('、') || '（なし）'}`);
  for (const g of games) {
    if (typeof g.mod.onListen === 'function') {
      try { g.mod.onListen({ port: PORT }); } catch (e) { console.error(`[エラー] ${g.id}`, e && e.stack || e); }
    }
  }
  console.log('');
  console.log('    このウィンドウを閉じるとサーバーが止まります。');
  console.log('');
  if (process.env.OPEN_BROWSER === '1') openBrowser(local);
});
