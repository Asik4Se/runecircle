# ゲームサーバー（ルーンサークル、ブロブアリーナ ほか）

このフォルダをインターネット上のサーバーに置くと、**URLを開くだけで誰でも遊べるサイト**になります。
トップページでゲームを選び、ひとりでも、URLや部屋コードを送ればみんなでも遊べます。

| ゲーム | URL | 内容 |
|---|---|---|
| ルーンサークル | `/runecircle/` | 魔法陣にルーンを刻んで戦うローグライト。1〜4人の協力プレイ |
| ブロブアリーナ | `/blob-arena/` | Agar.io風の捕食バトル。人数無制限、5分間の対戦 |

- プレイヤーは何もインストールしません。スマホでもパソコンでも遊べます
- サーバーは Node.js だけで動きます（追加のインストールは不要）
- 更新したいときは、ファイルを差し替えるだけで全員に届きます

ここでは、無料で使える **Render** に置く手順を説明します。

---

## 1. GitHub にファイルを置く

Render は GitHub にあるファイルを読み込んで動きます。このリポジトリをそのまま使えます。

## 2. Render で公開する

1. [render.com](https://render.com) を開き、「Get Started」→「GitHub」でログインする
2. 画面右上の「New」→「Web Service」
3. 「Connect a repository」で、このリポジトリを選ぶ（初回は GitHub への許可を求められるので許可する）
4. 設定はこのとおりにする

   | 項目 | 入れるもの |
   |---|---|
   | Name | `runecircle`（URLの一部になります） |
   | Language（Runtime） | `Node` |
   | Branch | `main` |
   | Root Directory | 空欄（このリポジトリの一番上） |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Health Check Path | `/healthz` |
   | Instance Type | `Free` |

5. 「Deploy Web Service」を押す
6. 数分待つと、画面の上に `https://runecircle-xxxx.onrender.com` のようなURLが出ます

**このURLを、遊んでほしい人に送れば完了です。** ゲームを直接開いてほしいときは、`/blob-arena/` のようにゲームのURLを送ります。

> 設定を入力する代わりに、「New」→「Blueprint」でこのリポジトリを選ぶと、`render.yaml` の内容で自動設定されます。
> すでに Render につないでいる場合は、GitHub に反映するだけで自動で新しい版に切り替わります。

---

## 更新のしかた

1. GitHub のリポジトリに、変わったファイルを反映する
2. Render が自動で読み込み直し、1〜3分で新しい版に切り替わります

プレイヤーは、ページを開き直す（再読み込みする）だけで新しい版で遊べます。セーブはそのまま残ります。

> 更新で切り替わる瞬間、そのとき遊んでいるオンラインの部屋（どのゲームも）は消えます。みんなが遊んでいない時間に更新してください。

---

## 自分のパソコンで動かす

```
node server.js
```

`http://localhost:8080` を開くとゲーム選択ページが出ます。同じWi-Fiの人には、起動時に表示される `http://192.168.…:8080` を送ります。

---

## 知っておいてほしいこと

**無料プランは、しばらく使われないと眠ります**
15分ほど誰もアクセスしないとサーバーが止まり、次に開いたとき表示まで30秒〜1分ほどかかります。一度起きれば、あとは普通に動きます。

**セーブはブラウザごと**
- 同じサイトを同じブラウザで開けば、続きから遊べます（ゲームごとに別々に保存されます）
- スマホとパソコンなど、別のブラウザ同士ではセーブは共有されません
- ブラウザの「閲覧データの削除」や、シークレットモード（プライベートブラウズ）では残りません

**サイトのURLは変えないでください**
セーブはサイトのURLごとに保存されます。Render の Name を変えるなどしてURLが変わると、それまでのセーブは新しいURLでは読めません。
（以前トップページにあったルーンサークルは `/runecircle/` に移りましたが、同じサイトなのでセーブはそのまま使えます。以前の `/?server=…` のリンクも自動でルーンサークルへ案内します）

**部屋の上限**
- ルーンサークル：誰も使わなくなった部屋は2時間で片付けられます。同時に作れる部屋は500まで（環境変数 `RC_MAX_ROOMS`）
- ブロブアリーナ：全員が抜けた部屋はすぐ片付けられます。同時に作れる部屋は200まで（環境変数 `BLOB_MAX_ROOMS`）

---

## ゲームを追加するとき

`games/<ゲームのID>/` フォルダを作り、その中に `game.js` を置くと、サーバーが自動で読み込んでトップページに並べます。

- `game.js` は `meta`（`id` はフォルダ名と同じにする、`title`・`tagline`・`description`・`players`・`glyph`・`colors`・`order`）を書き出す
- 画面のファイルは `public/` に置くと `/<ゲームのID>/` で配信されます
- WebSocket を使うときは `ws.onConnection(conn, req)` を書き出すと、`/<ゲームのID>/ws` への接続が渡されます（`lib/ws.js` の接続。`conn.send(text)`、`conn.on('message')`、`conn.on('close')`）
- 独自のURLを扱うときは `handle(req, res, url)` を書き出し、扱ったら `true` を返します

例は `games/blob-arena/game.js`（WebSocket）と `games/runecircle/game.js`（独自のAPI）です。

---

## Render 以外に置く場合

| 置き場所 | やり方 |
|---|---|
| Railway | リポジトリをつなぐだけで `package.json` から自動で起動します |
| Fly.io・Koyeb など | 同梱の `Dockerfile` を使います |
| そのほかの Node.js が動くサーバー | `node server.js` で起動し、環境変数 `RC_HOSTED=1` を設定してください |

Render・Railway・Fly.io・Koyeb では、公開サイトとして動いていることを自動で判定します。

---

## フォルダの中身

| ファイル | 役割 |
|---|---|
| `server.js` | ゲーム選択サーバー（トップページ、各ゲームの配信と通信の振り分け） |
| `launcher/index.html` | トップページ（ゲーム選択） |
| `lib/ws.js` | 追加インストールなしで動く WebSocket 通信 |
| `games/runecircle/` | ルーンサークル（`index.html` がゲーム本体、`game.js` がオンラインの部屋の管理） |
| `games/blob-arena/` | ブロブアリーナ（`public/core.js` がルール本体で数値は先頭の `CFG`、`game.js` が部屋と試合の計算、`build-solo.js` でひとり練習版の1ファイルHTMLを作成） |
| `package.json` | Node.js で起動するための設定 |
| `render.yaml` | Render の自動設定（Blueprint 用） |
| `Dockerfile` | Docker で動かす場所に置くとき用 |
