# ルーンサークル（公開サイト版）

このフォルダをインターネット上のサーバーに置くと、**URLを開くだけで誰でも遊べるサイト**になります。

- 一人用もオンライン協力プレイも、同じURLで遊べます
- プレイヤーは何もインストールしません。スマホでもパソコンでも遊べます
- セーブ（続きから・キャラの解放・戦績・図鑑）は、それぞれのブラウザに保存されます
- 更新したいときは、ファイルを差し替えるだけで全員に届きます

ここでは、無料で使える **Render** に置く手順を説明します。

---

## 1. GitHub にファイルを置く

Render は GitHub にあるファイルを読み込んで動きます。

1. [github.com](https://github.com) でアカウントを作る（すでにあれば不要）
2. 右上の「＋」→「New repository」
   - Repository name：`runecircle` など好きな名前
   - Public（公開）でも Private（非公開）でも構いません
   - 「Create repository」を押す
3. 作ったリポジトリの画面で「uploading an existing file」（または「Add file」→「Upload files」）を押す
4. このフォルダの中のファイルを**全部**ドラッグして入れる
   - `index.html` `server.js` `package.json` `render.yaml` `Dockerfile` `README.md`
   - `.gitignore` などの「.」で始まるファイルは見えないことがありますが、なくても動きます
5. 下の「Commit changes」を押す

## 2. Render で公開する

1. [render.com](https://render.com) を開き、「Get Started」→「GitHub」でログインする
2. 画面右上の「New」→「Web Service」
3. 「Connect a repository」で、さきほどのリポジトリを選ぶ（初回は GitHub への許可を求められるので許可する）
4. 設定はこのとおりにする

   | 項目 | 入れるもの |
   |---|---|
   | Name | `runecircle`（URLの一部になります） |
   | Language（Runtime） | `Node` |
   | Branch | `main` |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Instance Type | `Free` |

5. 「Deploy Web Service」を押す
6. 数分待つと、画面の上に `https://runecircle-xxxx.onrender.com` のようなURLが出ます

**このURLを、遊んでほしい人に送れば完了です。**

> 設定を入力する代わりに、「New」→「Blueprint」でこのリポジトリを選ぶと、`render.yaml` の内容で自動設定されます。

---

## 更新のしかた

1. GitHub のリポジトリを開き、「Add file」→「Upload files」
2. 新しい `index.html`（変わっていれば `server.js` も）をドラッグして「Commit changes」
3. Render が自動で読み込み直し、1〜3分で新しい版に切り替わります

プレイヤーは、ページを開き直す（再読み込みする）だけで新しい版で遊べます。セーブはそのまま残ります。

> 更新で切り替わる瞬間、そのとき遊んでいるオンラインの部屋は消えます。みんなが遊んでいない時間に更新してください。

---

## 知っておいてほしいこと

**無料プランは、しばらく使われないと眠ります**
15分ほど誰もアクセスしないとサーバーが止まり、次に開いたとき表示まで30秒〜1分ほどかかります。一度起きれば、あとは普通に動きます。

**セーブはブラウザごと**
- 同じURLを同じブラウザで開けば、続きから遊べます
- スマホとパソコンなど、別のブラウザ同士ではセーブは共有されません
- ブラウザの「閲覧データの削除」や、シークレットモード（プライベートブラウズ）では残りません

**URLは変えないでください**
セーブはURLごとに保存されます。Render の Name を変えるなどしてURLが変わると、それまでのセーブは新しいURLでは読めません。

**部屋の上限**
誰も使わなくなった部屋は2時間で片付けられます。同時に作れる部屋は500までです（環境変数 `RC_MAX_ROOMS` で変えられます）。

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
| `index.html` | ゲーム本体 |
| `server.js` | サーバー（ゲームの配信とオンラインの部屋の管理） |
| `package.json` | Node.js で起動するための設定 |
| `render.yaml` | Render の自動設定（Blueprint 用） |
| `Dockerfile` | Docker で動かす場所に置くとき用 |
