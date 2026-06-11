import type { DeepPartialDict } from "./types";

/** ja — 日本語訳。zh-CN を基準に生成;缺失键运行时回退简体中文。 */
export const ja: DeepPartialDict = {
  meta: {
    title: "BingchaAI — ワンクリックおかわり、AI コーディングツールの公式アカウント引き継ぎ",
    description:
      "BingchaAI は、Antigravity IDE・OpenAI Codex・Claude Code などの AI コーディングツールをワンクリックで引き継ぐデスクトップクライアントです。本物の公式サブスクリプションアカウントを使用し、API Key 不要、速度低下も上乗せ料金もありません。",
    faqTitle: "よくある質問 — BingchaAI",
    faqDescription:
      "BingchaAI のよくある質問:ファミリーグループへの参加、クライアントの引き継ぎ、カードとクォータなど。",
    featuresTitle: "クライアント機能 — BingchaAI",
    featuresDescription:
      "BingchaAI デスクトップクライアント:リアルタイムダッシュボード、モデルクォータの残量バー、引き継ぎコントロール、節約額トラッキング、全プラットフォーム対応。",
    howTitle: "仕組み — BingchaAI",
    howDescription:
      "BingchaAI があなたの PC と公式 API の間で行うこと:ローカルプロキシがトークンを注入し、公式サーバーへ直結。仲介は一切ありません。",
    quickstartTitle: "クイックスタート — BingchaAI",
    quickstartDescription:
      "3 ステップで始める BingchaAI:クライアントをダウンロード、カードを入力、ワンクリックで引き継ぎ。30 秒以内に使い始められます。",
    downloadTitle: "クライアントのダウンロード — BingchaAI",
    downloadDescription:
      "Windows・macOS・Linux 対応の BingchaAI デスクトップクライアントをダウンロード。ワンクリックおかわり、カードを入力するだけで使えます。",
  },

  common: {
    downloadClient: "クライアントをダウンロード",
    buyCard: "カードを購入 ↗",
    brandName: "BingchaAI",
  },

  nav: {
    features: "クライアント機能",
    howItWorks: "仕組み",
    quickstart: "クイックスタート",
    faq: "よくある質問",
    menu: "メニュー",
    mainNav: "メインナビゲーション",
    toggleTheme: "ライト / ダークテーマを切り替え",
  },

  footer: {
    desc: "主要な AI コーディングツールの公式アカウント引き継ぎツール。公式直結、仲介なし。",
    product: "製品",
    download: "クライアントをダウンロード",
    features: "クライアント機能",
    quickstart: "クイックスタート",
    howItWorks: "仕組み",
    help: "ヘルプ",
    faq: "よくある質問",
    store: "Bingcha ストア ↗",
    api: "Bingcha API ↗",
    terminal: "Bingcha ターミナル ↗",
    copyright: "© 2026 BingchaAI",
    tagline: "公式直結 · 仲介なし · コードは私たちを経由しません",
  },

  mock: {
    proxyStatus: "プロキシ状態",
    running: "稼働中",
    todayRequests: "本日のリクエスト",
    errors: "エラー数",
    inputTokens: "入力トークン",
    outputTokens: "出力トークン",
    takeoverStatus: "引き継ぎ状態",
    takenOver: "引き継ぎ済み",
    notTakenOver: "未引き継ぎ",
    modelQuota: "モデルクォータ",
  },

  home: {
    eyebrow: "/ 公式アカウント引き継ぎ、ワンクリックおかわり",
    h1Line1: "AI コーディングツールが",
    h1Line2Prefix: "直結するのは",
    h1Line2Accent: "公式アカウント",
    sub: "BingchaAI が本物の公式サブスクリプションアカウントを割り当て、Antigravity・Claude Code・Codex CLI はこれまで通り公式サーバーに直結します。API Key の設定も、ツールの乗り換えも、アカウント制限の心配を自分で抱える必要もありません。",
    trust1: "公式直結",
    trust2: "仲介なし",
    trust3: "コードは私たちを経由しません",
    ecosystemsTitle: "1 つのクライアント、3 つのエコシステム",
    ecosystemsLead:
      "主要な AI コーディングツールがそのまま使えます。引き継ぎ後も普段どおり使うだけで、モデルへのリクエストは自動的に BingchaAI のアカウントプールを経由します。",
    ecosystems: [
      {
        name: "Antigravity",
        tag: "IDE · Hub",
        desc: "Google の AI コーディング IDE。引き継ぎ後は Gemini / Claude のリクエストが自動的に BingchaAI のアカウントプールを経由し、エディタ側は何も変わりません。",
      },
      {
        name: "OpenAI Codex",
        tag: "CLI",
        desc: "OpenAI の AI コーディングエージェント。ChatGPT Plus / Pro のトークンを自動取得し、codex コマンドがそのまま使えます。API Key には触れません。",
      },
      {
        name: "Claude Code",
        tag: "CLI · VSCode · Desktop",
        desc: "Claude Code CLI・VS Code 拡張・macOS デスクトップ版が Max / Pro サブスクリプションに直結。クォータを使い切っても自動でおかわりします。",
      },
    ],
    logoAlt: "{name} のロゴ",
    howTitle: "トークンはローカルで注入、接続は公式へ直結",
    howLead:
      "本物の公式トークンをローカルのツールに注入し、コードは公式エンドポイントへ直接送信されます。BingchaAI はローカルプロキシ層でトークンを差し替えるだけで、仲介は行いません。",
    how: [
      {
        t: "ローカルプロキシを起動",
        d: "軽量プロキシをローカルで起動し、各ツールの標準的な方法で引き継ぎます。コードには手を付けず、ワンクリックで元に戻せます。",
      },
      {
        t: "必要なときに公式アカウントをリース",
        d: "ツールがリクエストを送ると、その瞬間にアカウントプールから本物の公式トークンをリースします。遅延の増加はほぼゼロです。",
      },
      {
        t: "トークンを差し替えて公式へ直結",
        d: "プレースホルダーのトークンを本物に差し替え、公式エンドポイントへ直接送信。コードが BingchaAI を経由することはありません。",
      },
      {
        t: "リアルタイム集計、自動アカウント交換",
        d: "レスポンスを返しながら使用量を集計。クォータを使い切ったり、アカウント制限に遭った場合は、自動で予備アカウントに切り替えます。",
      },
    ],
    quickstartLabel: "クイックスタート",
    quickstartSteps: ["クライアントをダウンロード", "カードを入力", "「引き継ぐ」をクリック"],
    quickstartNote: "30 秒足らずで、いつも通りコーディング",
    capsTitle: "アカウントプールの複雑さは、私たちが引き受けます",
    capsLead:
      "単一アカウントは使い切れるし、制限も受けるし、混み合いもします。スマートなスケジューリング、固定エグレス、リスク隔離で、あなたはコードを書くことに集中できます。",
    caps: [
      {
        t: "スマートなプールスケジューリング",
        d: "ランダムな割り当てではありません。アカウントの親和性・負荷分散・プランのグレード・各モデルの残りクォータを総合的にスコアリングし、毎回その時点で最適なアカウントを選びます。",
      },
      {
        t: "共有 / 専用クォータを自由に選択",
        d: "プールカードは複数ユーザーでアカウントを共有してお得に、バインドカードはアカウントを専有して安定したクォータを確保。同じアカウントを複数人で共有する場合も、公平な割り当てアルゴリズムにより各自の取り分が保証され、他人に使い尽くされる心配はありません。",
      },
      {
        t: "固定エグレスとリスク隔離",
        d: "オプションで住宅用の固定エグレス IP を利用でき、接続が安定し、IP 起因のリスク制御に引っかかりにくくなります。アカウントに問題が起きてもそのアカウントだけを隔離し、自動で交換・補充。ほかのユーザーには影響しません。",
      },
      {
        t: "リアルタイム残量バー",
        d: "ストリーミング応答と同時にトークンを集計し、サーバー側の 5 時間スライディングウィンドウをローカルにミラーリング。各モデルの残りクォータを実際のリセット時刻に合わせて表示し、使用量と節約額がひと目で分かります。",
      },
      {
        t: "ワンクリック引き継ぎ、設定ゼロ",
        d: "クライアントを開く → カードを入力 → 引き継ぎをクリック。API Key の設定も、ツールの乗り換えも、新しい操作の習得も不要。いつでもワンクリックで元に戻せます。",
      },
    ],
    compareTitle: "BingchaAI を選ぶ理由",
    compareLead: "自分でサブスクリプション契約する場合や API 中継と比べて、BingchaAI はカバー範囲・安定性・手軽さのすべてで優れています。",
    compareColUs: "BingchaAI",
    compareColOwn: "自分で契約",
    compareColRelay: "API 中継",
    compareRows: [
      ["公式サブスクリプションアカウントを使用", "はい", "はい", "いいえ(API Key)"],
      ["ネイティブ速度", "はい", "はい", "速度制限の可能性"],
      ["複数製品のカバー", "3 つのエコシステム", "個別契約が必要", "中継業者次第"],
      ["自動アカウント交換 / BAN 時の保険", "自動", "自己責任", "自己責任"],
      ["設定の手間", "設定ゼロ", "手動設定", "Key 入力 + 設定変更"],
      ["使用量の可視化", "ダッシュボード", "なし", "中継業者次第"],
    ],
    trustTitle: "あなたのコードは私たちを経由しません",
    trustLead: "BingchaAI クライアントはあなたの PC 上で動作し、やることはただ 1 つ:認証トークンをツールに注入することだけです。",
    trustPoints: [
      { b: "API Key を渡さない", s: "クライアントは認証トークンを注入するだけで、いかなるシークレットも第三者に公開しません。" },
      { b: "IDE の設定を変えない", s: "エディタ・プラグイン・ワークフローはそのまま。いつでもワンクリックで停止できます。" },
      { b: "コードを収集しない", s: "コードデータは公式サーバーへ直接送信されます。BingchaAI は中間者プロキシを行わず、何も保存しません。" },
    ],
    ctaTitle: "おかわりの準備はできましたか?",
    ctaSub: "BingchaAI クライアントをダウンロードするか、まずストアでカードを 1 枚購入してください。30 秒後にはいつも通りコーディングできます。",
  },

  download: {
    eyebrow: "/ ダウンロード",
    title: "BingchaAI クライアントをダウンロード",
    sub: "ワンクリックおかわり、IDE プラグイン不要。ダウンロード後すぐに実行し、カードを入力するだけで使えます。",
    recommended: "推奨",
    winMeta: "Windows 10 / 11 (64-bit) · v{version} · {size} MB",
    winHint: "インストール不要。ダウンロード後にダブルクリックで起動します。",
    downloadNow: "今すぐダウンロード",
    macMeta: "macOS 12+ · v{version}",
    macHint: "初回起動:アプリを右クリック → 開く → 確認して開く。",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    linuxMeta: "x86_64 · v{version}",
    downloadTar: "tar.gz をダウンロード",
    linuxHint: "展開後、chmod +x して実行します。",
    changelogTitle: "v{version} の更新内容",
    guideTitle: "使い方",
    steps: [
      "BingchaAI をダウンロードしてそのまま実行します(Windows はインストール不要、macOS はアプリケーションフォルダにドラッグ)。",
      "おかわりカードを入力するか、ローカルプールモードに切り替えて自分のアカウントを追加します。",
      "「引き継ぎ開始」をクリックして、Antigravity / Claude Code / Codex などのツールをこれまで通り使ってください。",
    ],
    autoUpdateNote: "クライアントは自動更新に対応しています。初回ダウンロード後は手動アップグレード不要です。",
  },

  features: {
    eyebrow: "/ クライアント機能",
    title: "すべての AI 呼び出しを掌握",
    sub: "ダッシュボード内蔵のネイティブデスクトップクライアント。使用量・クォータ・引き継ぎ状態をいつでも把握できます。",
    shotAlt: "リクエスト統計・モデルクォータの残量バー・引き継ぎ状態を表示する BingchaAI クライアントのコンソール",
    shotCaption: "クライアントコンソール — リクエスト統計・モデル使用量・引き継ぎ状態をリアルタイム表示",
    dashTitle: "リアルタイムダッシュボード",
    dash: [
      { t: "本日のリクエスト数", d: "AI モデルへのリクエスト総数をリアルタイムに集計。1 回の呼び出しまで正確にカウントします。" },
      { t: "エラー統計", d: "失敗したリクエストを記録し、問題の早期発見を助けます。" },
      { t: "入力 / 出力トークン", d: "送信・受信それぞれのトークン数を個別に集計します。" },
      {
        t: "節約額",
        d: "実際のモデルと公式サブスクリプション価格に基づきリアルタイムで計算。目を引く緑色の数字で価値がひと目で分かります。",
      },
    ],
    quotaTitle: "モデルクォータの残量バー",
    quotaIntroPre: "クライアントには",
    quotaIntroStrong: "リアルタイム残量バー",
    quotaIntroPost: "が内蔵されており、各モデルのクォータ消費を表示します。製品によってクォータウィンドウは異なります:",
    models: [
      {
        name: "Claude(Anthropic)",
        win: "5 時間ウィンドウ + 週次ウィンドウ",
        desc: "2 つのウィンドウを独立して計算。残量バーはリアルタイムに更新され、クォータリセットまでのカウントダウンを表示します。",
      },
      {
        name: "Codex(OpenAI)",
        win: "5 時間ウィンドウ + 週次ウィンドウ",
        desc: "デュアルウィンドウ方式で、ChatGPT Plus / Pro のクォータを正確に追跡します。",
      },
      {
        name: "Gemini(Google)",
        win: "単一クォータプール",
        desc: "Antigravity IDE 内の Gemini 使用量を、使用済み / 合計で表示します。",
      },
    ],
    resetNoteTitle: "クォータリセットのカウントダウン",
    resetNote: "クォータが残りわずかになると、残量バーに回復までの時間が表示され、作業ペースの調整に役立ちます。",
    takeoverTitle: "引き継ぎコントロールパネル",
    takeoverIntroPre: "製品ごとに独立したスイッチがあり、",
    takeoverIntroStrong: "引き継ぐツールを自由に選択",
    takeoverIntroPost: "できます。使わないツールはネイティブのままで影響を受けません。",
    takeover: [
      { name: "Antigravity IDE", s: "Gemini + Claude の両モデル" },
      { name: "Antigravity Hub", s: "AI 機能を完全カバー" },
      { name: "OpenAI Codex", s: "Plus / Pro クォータを直接利用" },
      { name: "Claude Code", s: "CLI + VS Code 拡張" },
      { name: "Claude Desktop", s: "macOS / Windows" },
    ],
    moreTitle: "その他のハイライト",
    more: [
      { t: "自動更新", d: "OTA 配信を内蔵し、新バージョンを自動でダウンロード・インストールします。" },
      { t: "お知らせ", d: "運営からのお知らせやメンテナンス通知をリアルタイムで受け取れます。" },
      { t: "リクエストログ", d: "すべてのリクエストの時刻・モデル・ステータスコードを完全に記録します。" },
      { t: "パス検出", d: "IDE / Hub / Codex のインストールパスを自動検出。手動指定にも対応します。" },
      { t: "全プラットフォーム対応", d: "Windows · macOS(Intel + Apple Silicon)· Linux。" },],
    settingsTitle: "設定ページ",
    settings: [
      ["IDE パス", "Antigravity IDE のインストールディレクトリ。自動検出または手動で選択。"],
      ["Hub パス", "Antigravity Hub のインストールディレクトリ。こちらも自動検出に対応。"],
      ["Codex パス", "Codex CLI のインストールパス設定。"],],
    ctaTitle: "実際に試してみませんか?",
    ctaSub: "BingchaAI クライアントをダウンロードして、これらの機能を体感してください。",
  },

  how: {
    eyebrow: "/ 仕組み",
    title: "トークンはローカルで注入、接続は公式へ直結",
    sub: "BingchaAI があなたの PC と公式 API の間で実際に行っていること。",
    archTitle: "アーキテクチャ概要",
    archP1Pre: "BingchaAI はあなたの PC 上で",
    archP1Strong1: "軽量なローカルプロキシ",
    archP1Mid: "を実行します。クラウド中継ではありません——あなたのコードと AI の対話データは",
    archP1Strong2: "私たちのサーバーを経由せず",
    archP1Post: "、Google・OpenAI・Anthropic の公式 API エンドポイントへ直接送信されます。",
    coreNoteTitle: "基本理念",
    coreNote:
      "BingchaAI がやることはただ 1 つ:リクエストに正しい公式サブスクリプショントークンを注入することです。リクエスト内容の改変も、レスポンスのキャッシュも、コードの記録もしない——純粋なトークン注入レイヤーです。",
    lifecycleTitle: "リクエストのライフサイクル",
    flow: [
      {
        t: "リクエストを捕捉",
        d: "ローカルプロキシ(127.0.0.1)が IDE から公式へのリクエストを透過的に捕捉します。Claude Code は環境変数、Codex は provider の切り替え、Claude デスクトップ版はローカル MITM 経由です。",
      },
      {
        t: "オンデマンドでアカウントをリース",
        d: "リースエンジンがアカウントプールから本物の公式アカウントトークン(クォータと有効期限付き)をリアルタイムにリースします。並行リクエストの重複排除とトークンキャッシュにより、遅延の増加はほぼゼロです。",
      },
      {
        t: "差し替えて直結",
        d: "プロキシがリクエスト内のプレースホルダートークンを本物のトークンに差し替え、api.anthropic.com / chatgpt.com の公式エンドポイントへ直接送信します。オプションで固定住宅エグレス経由も選べます。",
      },
      {
        t: "ストリーミングで返却",
        d: "公式のレスポンスはそのまま IDE に返され、転送しながらトークン使用量を集計します。体験はネイティブのサブスクリプションと完全に同じです。",
      },
    ],
    poolTitle: "アカウントプールのローテーション",
    poolIntro:
      "BingchaAI のバックエンドは本物の公式サブスクリプションアカウントのプールを維持しており、クライアントは「リース」によって利用可能なアカウントを動的に取得します:",
    pool: [
      { t: "自動リース更新", d: "トークンの有効期間中は自動で更新し、期限前に新しいトークンへシームレスに切り替えます。" },
      { t: "クォータ切れで切り替え", d: "現在のアカウントのクォータを使い切ると、プール内の残量があるアカウントへ自動で切り替えます。" },
      {
        t: "リスク隔離",
        d: "アカウントがプラットフォームから制限を受けた場合は自動的に使用不可としてプールから外し、ほかのユーザーに影響させません。",
      },
      { t: "自動アカウント補充", d: "バックエンドが新しいアカウントをプールに継続的に補充し、利用可能なアカウント数を十分に保ちます。" },
    ],
    productsTitle: "製品ごとの引き継ぎ体験",
    products: [
      {
        name: "Antigravity(IDE · Hub)",
        items: [
          "Gemini・Claude の両モデルを自動で引き継ぎ",
          "IDE / Hub 内の体験はネイティブのサブスクリプションと同じ",
          "引き継ぎを終了すると元の状態に自動復元",
        ],
      },
      {
        name: "OpenAI Codex CLI",
        items: [
          "codex コマンドがそのまま使え、手動でトークンを取得する必要なし",
          "ChatGPT Plus / Pro のクォータを自動取得",
          "公式 CLI と完全に同じ体験",
        ],
      },
      {
        name: "Claude Code · Desktop",
        items: [
          "CLI・VS Code 拡張・macOS/Windows デスクトップ版",
          "Claude の設定ファイルには一切手を付けず、ワンクリックで復元可能",
          "Max / Pro サブスクリプションのクォータに直結",
        ],
      },
    ],
    safetyTitle: "セキュリティモデル",
    safetyHeadline: "私たちのセキュリティの約束",
    safetyLead: "コードは公式へ直行し、ローカルプロキシはトークンを注入するだけです。",
    safe: [
      ["API Key を渡さない", "公式サブスクリプションのクォータを使用し、API 中継ではありません。"],
      ["IDE の設定を変えない", "引き継ぎ終了後、元の設定に自動復元します。"],
      ["コードを収集しない", "ローカルプロキシはトークンを注入するだけで、コードは公式へ直行します。"],
      ["仲介なし", "リクエストデータが BingchaAI のサーバーを経由することはありません。"],
    ],
  },

  quickstart: {
    eyebrow: "/ クイックスタート",
    title: "3 ステップ、30 秒で使い始める",
    sub: "クライアントをダウンロードし、カードを入力して、ワンクリックで引き継ぎ。API Key の設定もツールの乗り換えも不要です。",
    steps: [
      {
        t: "クライアントをダウンロード",
        d: "ダウンロードページからお使いのシステムに合ったバージョンを入手します。Windows はインストール不要、macOS はアプリケーションフォルダにドラッグ、Linux は展開して実行します。",
      },
      {
        t: "カードを入力",
        d: "クライアントを起動し、「アカウントカード設定」におかわりカード(形式 AI…)を入力して「認証して有効化」をクリックします。カードは bcai.store で購入できます。",
      },
      {
        t: "ワンクリックで引き継ぎ",
        d: "「引き継ぎ」パネルで対象の製品(IDE / Hub / Codex / Claude Code)を選んでスイッチをクリックするだけ。IDE のリクエストは自動的にローカルプロキシを経由します。",
      },
    ],
    goDownload: "ダウンロードへ →",
    cardTitle: "カードについて",
    cardWhatTitle: "カードとは?",
    cardWhat:
      "カードは BingchaAI を利用するための資格情報で、形式は AI… です。各カードには有効期間と対応製品の範囲が決まっており、期限が切れたら新しいカードを購入して更新できます。",
    cardBuyLabel: "購入先",
    cardBuyPre: "カードは ",
    cardBuyPost: " で購入できます。",
    cardExpiryLabel: "期限の確認",
    cardExpiry: "有効化後、クライアントで有効期限を確認できます。",
    cardRenewLabel: "更新",
    cardRenew: "期限前ならいつでも新しいカードを入力して更新でき、切れ目なく移行します。",
    cardPlanLabel: "プラン",
    cardPlan: "プランによって対応する製品の組み合わせが異なります(Antigravity / Codex / Claude)。",
    takeoverTitle: "引き継ぎパネル",
    takeoverIntro: "BingchaAI は 5 つの製品ターゲットを個別に引き継げます。それぞれに独立したスイッチがあります:",
    takeover: [
      ["Antigravity IDE", "Gemini・Claude の両モデルを自動で引き継ぎ。体験はネイティブと同じ"],
      ["Antigravity Hub", "Hub 内のすべての AI 機能をカバー。ほかの機能には影響なし"],
      ["OpenAI Codex", "codex コマンドがそのまま使え、Plus / Pro クォータを自動取得"],
      ["Claude Code", "CLI も VS Code 拡張も対応。Max / Pro サブスクリプションに直結"],
      ["Claude Desktop", "macOS / Windows 両プラットフォームのデスクトップ版を透過的に引き継ぎ"],
    ],
    ctaTitle: "カードをまだお持ちでない方は?",
    ctaSub: "Bingcha ストアでおかわりカードを購入できます。複数のプランからお選びください。",
  },

  faqPage: {
    eyebrow: "/ よくある質問",
    title: "よくある質問",
    sub: "ご利用中に問題がありましたら、ここで答えを探すか、サポートの WeChat を追加してください。",
    contactTitle: "サポート",
    contactDesc: "担当者によるサポートが必要な場合は、サポートの WeChat を追加してください。",
    copy: "コピー",
    copied: "コピーしました",
    qrAlt: "サポート WeChat の QR コード",
    scanToAdd: "スキャンして追加",
    searchPlaceholder: "質問を検索…",
    searchAria: "よくある質問を検索",
    noMatch: "一致する質問はありません。",
    empty: "よくある質問はまだありません。",
    questionCount: "{n} 件の質問",
  },









  statusLabels: {
    HEALTHY: "正常",
    LOGIN_REQUIRED: "要ログイン",
    VERIFICATION_REQUIRED: "要認証",
    DISABLED: "無効化済み",
    ACTIVE: "アクティブ",
    MANUAL_ONLY: "手動のみ",
    PENDING: "処理待ち",
    RUNNING: "実行中",
    TASK_QUEUED: "処理中",
    TASK_RUNNING: "タスク実行中",
    CODE_VERIFIED: "カード確認済み",
    GROUP_ASSIGNED: "グループ割当済み",
    INVITE_SENT: "招待送信済み",
    WAIT_USER_ACCEPT: "承認待ち",
    COMPLETED: "完了",
    FAILED: "失敗",
    EXPIRED: "期限切れ",
    CANCELLED: "キャンセル済み",
    MANUAL_REVIEW: "手動対応",
    REPLACED_AND_INVITE_SENT: "交換・招待済み",
    FAILED_FINAL: "最終失敗",
    FAILED_RETRYABLE: "再試行可能",
    INVITE_MEMBER: "メンバーを招待",
    REMOVE_MEMBER: "メンバーを削除",
    REPLACE_MEMBER: "メンバーを交換",
    SYNC_FAMILY_GROUP: "ファミリーグループを同期",
    HEALTH_CHECK_ACCOUNT: "ヘルスチェック",
    UNUSED: "未使用",
    USED: "使用済み",
    RESERVED: "予約済み",
    ACCEPTED: "承認済み",
    REMOVED: "削除済み",
    SENT: "送信済み",
    CREATED: "作成済み",
    SUSPENDED: "一時停止",
    SUCCESS: "成功",
    RISKY: "リスクあり",
    ADMIN: "管理者",
    OPERATIONS: "運用",
    SUPPORT: "サポート",
    OWNER: "オーナー",
    MEMBER: "メンバー",
    TOTP: "設定済み",
    "No TOTP": "未設定",
    GOOGLE_ONE: "Google One",
    REMOVING: "削除中",
    INVITING: "招待中",
    PARTIALLY_FAILED: "一部失敗",
    NOT_STARTED: "未開始",
  },
};
