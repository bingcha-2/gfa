import type { DeepPartialDict } from "./types";

/** 한국어 — zh-CN 기준 번역. 누락 키는 런타임에 zh-CN으로 폴백. */
export const ko: DeepPartialDict = {
  meta: {
    title: "BingchaAI — 원클릭 리필, AI 코딩 도구 공식 계정 테이크오버",
    description:
      "BingchaAI는 Antigravity IDE, OpenAI Codex, Claude Code 등 AI 코딩 도구를 실제 공식 구독 계정으로 원클릭 테이크오버하는 데스크톱 클라이언트입니다. API Key 불필요, 속도 저하 없음, 추가 요금 없음.",
    faqTitle: "자주 묻는 질문 — BingchaAI",
    faqDescription:
      "BingchaAI 사용 중 자주 묻는 질문: 패밀리 그룹 가입, 클라이언트 테이크오버, 카드와 쿼터 등.",
    featuresTitle: "클라이언트 기능 — BingchaAI",
    featuresDescription:
      "BingchaAI 데스크톱 클라이언트: 실시간 대시보드, 모델 쿼터 잔여량 바, 테이크오버 제어, 절감액 추적, 전 플랫폼 지원.",
    howTitle: "작동 원리 — BingchaAI",
    howDescription:
      "BingchaAI가 내 컴퓨터와 공식 API 사이에서 하는 일: 로컬 프록시가 토큰을 주입해 공식 서버에 직접 연결하며, 중개하지 않습니다.",
    quickstartTitle: "빠른 시작 — BingchaAI",
    quickstartDescription:
      "3단계로 시작하는 BingchaAI: 클라이언트 다운로드, 카드 입력, 원클릭 테이크오버. 30초 안에 시작할 수 있습니다.",
    downloadTitle: "클라이언트 다운로드 — BingchaAI",
    downloadDescription:
      "Windows, macOS, Linux를 지원하는 BingchaAI 데스크톱 클라이언트를 다운로드하세요. 원클릭 리필, 카드만 입력하면 바로 사용할 수 있습니다.",
  },

  common: {
    downloadClient: "클라이언트 다운로드",
    buyCard: "카드 구매 ↗",
    brandName: "BingchaAI",
  },

  nav: {
    features: "클라이언트 기능",
    howItWorks: "작동 원리",
    quickstart: "빠른 시작",
    faq: "자주 묻는 질문",
    menu: "메뉴",
    mainNav: "메인 내비게이션",
    toggleTheme: "라이트/다크 테마 전환",
  },

  footer: {
    desc: "주요 AI 코딩 도구를 위한 공식 계정 테이크오버 도구. 공식 서버에 직접 연결하며, 중개하지 않습니다.",
    product: "제품",
    download: "클라이언트 다운로드",
    features: "클라이언트 기능",
    quickstart: "빠른 시작",
    howItWorks: "작동 원리",
    help: "도움말",
    faq: "자주 묻는 질문",
    store: "Bingcha 스토어 ↗",
    api: "Bingcha API ↗",
    terminal: "Bingcha 터미널 ↗",
    copyright: "© 2026 BingchaAI",
    tagline: "공식 서버 직접 연결 · 중개하지 않음 · 코드는 우리를 거치지 않습니다",
  },

  mock: {
    proxyStatus: "프록시 상태",
    running: "실행 중",
    todayRequests: "오늘 요청",
    errors: "오류",
    inputTokens: "입력 토큰",
    outputTokens: "출력 토큰",
    takeoverStatus: "테이크오버 상태",
    takenOver: "테이크오버됨",
    notTakenOver: "꺼짐",
    modelQuota: "모델 쿼터",
  },

  home: {
    eyebrow: "/ 공식 계정 테이크오버, 원클릭 리필",
    h1Line1: "AI 코딩 도구에",
    h1Line2Prefix: "직접 연결되는 ",
    h1Line2Accent: "공식 계정",
    sub: "BingchaAI가 실제 공식 구독 계정을 배정해 Antigravity, Claude Code, Codex CLI가 평소처럼 공식 서버에 직접 연결되도록 합니다. API Key 설정도, 도구 교체도, 계정 제재 걱정도 필요 없습니다.",
    trust1: "공식 서버 직접 연결",
    trust2: "중개자 없음",
    trust3: "코드는 우리를 거치지 않습니다",
    ecosystemsTitle: "하나의 클라이언트, 세 가지 생태계",
    ecosystemsLead:
      "주요 AI 코딩 도구를 바로 사용할 수 있습니다. 테이크오버 후에도 평소처럼 쓰면 모델 요청이 자동으로 Bingcha 계정 풀을 거칩니다.",
    ecosystems: [
      {
        name: "Antigravity",
        tag: "IDE · Hub",
        desc: "Google의 AI 코딩 IDE. 테이크오버 후 Gemini / Claude 모델 요청이 자동으로 Bingcha 계정 풀을 거치며, 에디터는 전혀 느끼지 못합니다.",
      },
      {
        name: "OpenAI Codex",
        tag: "CLI",
        desc: "OpenAI의 AI 코딩 에이전트. ChatGPT Plus / Pro 토큰을 자동으로 받아 codex 명령을 그대로 쓸 수 있고, API Key는 건드리지 않습니다.",
      },
      {
        name: "Claude Code",
        tag: "CLI · VSCode · Desktop",
        desc: "Claude Code CLI, VS Code 확장, macOS 데스크톱 앱이 Max / Pro 구독에 직접 연결됩니다. 쿼터가 소진되면 자동으로 리필됩니다.",
      },
    ],
    logoAlt: "{name} 로고",
    howTitle: "로컬에서 토큰 주입, 공식 서버 직접 연결",
    howLead:
      "실제 공식 토큰을 내 컴퓨터의 도구에 주입하고, 코드는 공식 엔드포인트로 직접 전송됩니다. Bingcha는 로컬 프록시 계층에서 토큰만 교체할 뿐, 중개하지 않습니다.",
    how: [
      {
        t: "로컬 프록시 시작",
        d: "내 컴퓨터에 경량 프록시를 띄우고 각 도구의 표준 방식으로 테이크오버합니다. 코드는 건드리지 않고, 원클릭으로 되돌릴 수 있습니다.",
      },
      {
        t: "필요할 때 공식 계정 임대",
        d: "도구가 요청을 보내는 순간 계정 풀에서 실제 공식 토큰을 실시간으로 임대합니다. 지연은 거의 늘지 않습니다.",
      },
      {
        t: "토큰 교체 후 공식 서버 직행",
        d: "플레이스홀더 토큰을 진짜 토큰으로 바꿔 공식 엔드포인트로 바로 보냅니다. 코드는 Bingcha를 거치지 않습니다.",
      },
      {
        t: "실시간 통계, 자동 계정 교체",
        d: "응답이 흐르는 동안 사용량을 집계하고, 쿼터가 소진되거나 계정이 제재되면 자동으로 예비 계정으로 전환합니다.",
      },
    ],
    quickstartLabel: "빠른 시작",
    quickstartSteps: ["클라이언트 다운로드", "카드 입력", "테이크오버 클릭"],
    quickstartNote: "30초 안에 끝, 평소처럼 코딩하세요",
    capsTitle: "계정 풀의 복잡함은 저희가 막아 드립니다",
    capsLead:
      "단일 계정은 소진되고, 제재받고, 붐비기 마련입니다. 스마트 스케줄링, 고정 출구, 리스크 격리로 당신은 코드만 쓰면 됩니다.",
    caps: [
      {
        t: "스마트 계정 풀 스케줄링",
        d: "무작위 배정이 아닙니다. 계정 친화도, 부하 분산, 플랜 등급, 모델별 잔여 쿼터를 종합 평가해 매번 그 순간 최적의 계정을 고릅니다.",
      },
      {
        t: "공유 / 전용 쿼터, 자유롭게 선택",
        d: "풀 카드는 여러 사용자가 계정을 공유해 더 경제적이고, 바인딩 카드는 계정을 전용으로 써서 쿼터가 더 안정적입니다. 한 계정을 여럿이 공유할 때는 공정 배분 알고리즘이 각자의 몫을 보장해, 누구도 독차지할 수 없습니다.",
      },
      {
        t: "고정 출구, 리스크 격리",
        d: "주거용 고정 출구 IP를 선택할 수 있어 연결이 안정적이고 IP로 인한 제재 가능성이 낮습니다. 한 계정에 문제가 생기면 그 계정만 격리하고 자동으로 교체·보충하므로 다른 사용자에게 영향이 없습니다.",
      },
      {
        t: "실시간 쿼터 잔여량 바",
        d: "스트리밍 응답과 동시에 토큰을 집계하고, 서버의 5시간 슬라이딩 윈도우를 로컬에 미러링합니다. 모델별 잔여 쿼터를 실제 리셋 시간에 맞춰 보여 주어 사용량과 절감액이 한눈에 들어옵니다.",
      },
      {
        t: "원클릭 테이크오버, 제로 설정",
        d: "클라이언트 열기 → 카드 입력 → 테이크오버 클릭. API Key 설정도, 도구 교체도, 새로 배울 것도 없으며 언제든 원클릭으로 되돌릴 수 있습니다.",
      },
    ],
    compareTitle: "왜 BingchaAI인가",
    compareLead: "직접 구독이나 API 중계와 비교해 Bingcha는 커버리지, 안정성, 편의성 모두에서 더 유리합니다.",
    compareColUs: "BingchaAI",
    compareColOwn: "직접 구독",
    compareColRelay: "API 중계",
    compareRows: [
      ["공식 구독 계정 사용", "예", "예", "아니요 (API Key)"],
      ["네이티브 속도", "예", "예", "제한될 수 있음"],
      ["다중 제품 커버", "3대 생태계", "개별 구독 필요", "업체에 따라 다름"],
      ["자동 계정 교체 / 차단 대비", "자동", "본인 부담", "본인 부담"],
      ["설정 복잡도", "제로 설정", "수동 설정", "Key 입력 + 설정 수정"],
      ["사용량 시각화", "대시보드", "없음", "업체에 따라 다름"],
    ],
    trustTitle: "코드는 우리를 거치지 않습니다",
    trustLead: "BingchaAI 클라이언트는 내 컴퓨터에서 실행되며 단 한 가지 일만 합니다: 도구에 인증 토큰을 주입하는 것.",
    trustPoints: [
      { b: "API Key를 보내지 않음", s: "클라이언트는 인증 토큰만 주입하며, 어떤 비밀 키도 제3자에게 노출하지 않습니다." },
      { b: "IDE 설정을 바꾸지 않음", s: "에디터, 플러그인, 워크플로는 그대로 유지되며 언제든 원클릭으로 끌 수 있습니다." },
      { b: "코드를 수집하지 않음", s: "코드 데이터는 공식 서버로 직접 전송됩니다. Bingcha는 중개 프록시를 하지 않으며 아무것도 보관하지 않습니다." },
    ],
    ctaTitle: "리필할 준비 되셨나요?",
    ctaSub: "BingchaAI 클라이언트를 다운로드하거나 스토어에서 카드를 먼저 구매하세요. 30초 뒤면 평소처럼 코딩할 수 있습니다.",
  },

  download: {
    eyebrow: "/ 다운로드",
    title: "BingchaAI 클라이언트 다운로드",
    sub: "원클릭 리필, IDE 플러그인 불필요. 다운로드 후 바로 실행하고 카드만 입력하면 됩니다.",
    recommended: "추천",
    winMeta: "Windows 10 / 11 (64-bit) · v{version} · {size} MB",
    winHint: "설치 불필요, 다운로드 후 더블 클릭으로 바로 실행됩니다.",
    downloadNow: "지금 다운로드",
    macMeta: "macOS 12+ · v{version}",
    macHint: "처음 열 때: 앱 우클릭 → 열기 → 열기 확인.",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    linuxMeta: "x86_64 · v{version}",
    downloadTar: "tar.gz 다운로드",
    linuxHint: "압축 해제 후 chmod +x로 실행하세요.",
    changelogTitle: "v{version} 변경 사항",
    guideTitle: "사용 안내",
    steps: [
      "BingchaAI를 다운로드한 뒤 바로 실행하세요 (Windows는 설치 불필요, macOS는 응용 프로그램 폴더로 드래그).",
      "리필 카드를 입력하거나, 로컬 풀 모드로 전환해 보유한 계정을 추가하세요.",
      "“테이크오버 시작”을 클릭하고 Antigravity / Claude Code / Codex 등에서 평소처럼 사용하세요.",
    ],
    autoUpdateNote: "클라이언트는 자동 업데이트를 지원하므로 처음 다운로드한 뒤에는 수동 업그레이드가 필요 없습니다.",
  },

  features: {
    eyebrow: "/ 클라이언트 기능",
    title: "모든 AI 호출을 내 손안에",
    sub: "대시보드를 내장한 네이티브 데스크톱 클라이언트로 사용량, 쿼터, 테이크오버 상태를 언제든 확인할 수 있습니다.",
    shotAlt: "요청 통계, 모델 쿼터 잔여량 바, 테이크오버 상태를 보여 주는 BingchaAI 클라이언트 콘솔",
    shotCaption: "클라이언트 콘솔 — 요청 통계, 모델 사용량, 테이크오버 상태를 실시간 표시",
    dashTitle: "실시간 대시보드",
    dash: [
      { t: "오늘 요청 수", d: "AI 모델 요청 총량을 호출 단위까지 실시간으로 집계합니다." },
      { t: "오류 통계", d: "요청 실패 횟수를 기록해 문제를 빠르게 파악할 수 있습니다." },
      { t: "입력 / 출력 토큰", d: "보낸 토큰과 받은 토큰 수를 따로 집계합니다." },
      {
        t: "절감액",
        d: "실제 사용 모델과 공식 구독 가격 기준으로 실시간 계산되어, 눈에 띄는 초록색 숫자로 가치를 바로 확인할 수 있습니다.",
      },
    ],
    quotaTitle: "모델 쿼터 잔여량 바",
    quotaIntroPre: "클라이언트에 내장된 ",
    quotaIntroStrong: "실시간 잔여량 바",
    quotaIntroPost: "가 모델별 쿼터 소비를 보여 줍니다. 제품마다 쿼터 윈도우가 다릅니다:",
    models: [
      {
        name: "Claude (Anthropic)",
        win: "5시간 윈도우 + 주간 윈도우",
        desc: "두 윈도우를 독립적으로 계산하며, 잔여량 바가 실시간 갱신되고 쿼터 리셋 카운트다운을 표시합니다.",
      },
      {
        name: "Codex (OpenAI)",
        win: "5시간 윈도우 + 주간 윈도우",
        desc: "이중 윈도우 방식으로 ChatGPT Plus / Pro 쿼터를 정밀하게 추적합니다.",
      },
      {
        name: "Gemini (Google)",
        win: "단일 쿼터 풀",
        desc: "Antigravity IDE의 Gemini 사용량을 사용 / 전체로 표시합니다.",
      },
    ],
    resetNoteTitle: "쿼터 리셋 카운트다운",
    resetNote: "쿼터가 거의 소진되면 잔여량 바에 회복까지 남은 시간이 표시되어 작업 리듬을 계획하기 좋습니다.",
    takeoverTitle: "테이크오버 컨트롤 패널",
    takeoverIntroPre: "제품마다 독립 스위치가 있어 ",
    takeoverIntroStrong: "원하는 도구만 골라 테이크오버",
    takeoverIntroPost: "할 수 있습니다. 쓰지 않는 도구는 원래 상태 그대로 유지됩니다.",
    takeover: [
      { name: "Antigravity IDE", s: "Gemini + Claude 듀얼 모델" },
      { name: "Antigravity Hub", s: "모든 AI 기능 커버" },
      { name: "OpenAI Codex", s: "Plus / Pro 쿼터 바로 사용" },
      { name: "Claude Code", s: "CLI + VS Code 확장" },
      { name: "Claude Desktop", s: "macOS / Windows" },
    ],
    moreTitle: "그 밖의 특징",
    more: [
      { t: "자동 업데이트", d: "OTA 푸시가 내장되어 새 버전이 자동으로 다운로드·설치됩니다." },
      { t: "공지 시스템", d: "운영 공지와 점검 알림을 실시간으로 받습니다." },
      { t: "요청 로그", d: "모든 요청의 시간, 모델, 상태 코드를 빠짐없이 기록합니다." },
      { t: "경로 감지", d: "IDE / Hub / Codex 설치 경로를 자동 감지하며 수동 지정도 지원합니다." },
      { t: "전 플랫폼 지원", d: "Windows · macOS (Intel + Apple Silicon) · Linux." },],
    settingsTitle: "설정 페이지",
    settings: [
      ["IDE 경로", "Antigravity IDE 설치 디렉터리, 자동 감지 또는 수동 선택."],
      ["Hub 경로", "Antigravity Hub 설치 디렉터리, 마찬가지로 자동 감지 지원."],
      ["Codex 경로", "Codex CLI 설치 경로 설정."],],
    ctaTitle: "직접 체험해 보시겠어요?",
    ctaSub: "BingchaAI 클라이언트를 다운로드해 이 기능들을 직접 경험해 보세요.",
  },

  how: {
    eyebrow: "/ 작동 원리",
    title: "로컬에서 토큰 주입, 공식 서버 직접 연결",
    sub: "BingchaAI가 내 컴퓨터와 공식 API 사이에서 정확히 무엇을 하는지 알아봅니다.",
    archTitle: "아키텍처 개요",
    archP1Pre: "BingchaAI는 내 컴퓨터에서 ",
    archP1Strong1: "경량 로컬 프록시",
    archP1Mid: "를 실행합니다. 클라우드 중계가 아닙니다 — 코드와 AI 대화 데이터는 ",
    archP1Strong2: "우리 서버를 거치지 않고",
    archP1Post: " Google, OpenAI, Anthropic의 공식 API 엔드포인트로 직접 전송됩니다.",
    coreNoteTitle: "핵심 원칙",
    coreNote:
      "BingchaAI는 단 한 가지 일만 합니다: 요청에 올바른 공식 구독 토큰을 주입하는 것. 요청 내용을 수정하지 않고, 응답을 캐시하지 않고, 코드를 기록하지 않습니다 — 순수한 토큰 주입 계층입니다.",
    lifecycleTitle: "요청 라이프사이클",
    flow: [
      {
        t: "요청 인터셉트",
        d: "로컬 프록시(127.0.0.1)가 IDE에서 공식 서버로 가는 요청을 투명하게 인터셉트합니다. Claude Code는 환경 변수 변경, Codex는 provider 전환, Claude Desktop은 로컬 MITM 방식입니다.",
      },
      {
        t: "필요할 때 계정 임대",
        d: "임대 엔진이 계정 풀에서 실제 공식 계정 토큰(쿼터·유효 기간 포함)을 실시간으로 임대합니다. 동시 요청 중복 제거 + 토큰 캐싱으로 지연이 거의 없습니다.",
      },
      {
        t: "교체 후 직접 연결",
        d: "프록시가 요청 속 플레이스홀더 토큰을 실제 토큰으로 바꿔 api.anthropic.com / chatgpt.com 공식 엔드포인트로 직접 보냅니다. 고정 주거용 출구를 선택적으로 경유할 수 있습니다.",
      },
      {
        t: "스트리밍 응답",
        d: "공식 응답은 그대로 IDE로 돌아가며, 전달과 동시에 토큰 사용량을 집계합니다. 경험은 네이티브 구독과 완전히 동일합니다.",
      },
    ],
    poolTitle: "계정 풀 로테이션",
    poolIntro:
      "Bingcha 백엔드는 실제 공식 구독 계정의 계정 풀을 운영하며, 클라이언트는 “임대” 방식으로 사용 가능한 계정을 동적으로 받아 옵니다:",
    pool: [
      { t: "자동 갱신", d: "토큰 유효 기간 내 자동으로 갱신하고, 만료 전에 새 토큰으로 매끄럽게 전환합니다." },
      { t: "쿼터 소진 시 전환", d: "현재 계정의 쿼터가 소진되면 풀에서 여유가 있는 다른 계정으로 자동 전환합니다." },
      {
        t: "리스크 격리",
        d: "플랫폼 제재를 받은 계정은 자동으로 사용 불가 표시 후 풀에서 제외되어 다른 사용자에게 영향이 없습니다.",
      },
      { t: "자동 보충", d: "백엔드가 새 계정을 풀에 계속 보충해 가용 계정 수를 충분히 유지합니다." },
    ],
    productsTitle: "제품별 테이크오버 경험",
    products: [
      {
        name: "Antigravity (IDE · Hub)",
        items: [
          "Gemini, Claude 두 모델 모두 자동 테이크오버",
          "IDE / Hub 내 경험은 네이티브 구독과 동일",
          "테이크오버 해제 시 원래 상태로 자동 복원",
        ],
      },
      {
        name: "OpenAI Codex CLI",
        items: [
          "codex 명령을 그대로 사용, 토큰 수동 발급 불필요",
          "ChatGPT Plus / Pro 쿼터 자동 획득",
          "공식 CLI와 완전히 동일한 경험",
        ],
      },
      {
        name: "Claude Code · Desktop",
        items: [
          "CLI, VS Code 확장, macOS/Windows 데스크톱",
          "Claude 설정 파일을 일절 수정하지 않으며 원클릭 복원 가능",
          "Max / Pro 구독 쿼터에 직접 연결",
        ],
      },
    ],
    safetyTitle: "보안 모델",
    safetyHeadline: "우리의 보안 약속",
    safetyLead: "코드는 공식 서버로 직행하고, 로컬 프록시는 토큰만 주입합니다.",
    safe: [
      ["API Key를 보내지 않음", "공식 구독 쿼터를 사용하며, API 중계가 아닙니다."],
      ["IDE 설정을 바꾸지 않음", "테이크오버 해제 시 원래 설정이 자동 복원됩니다."],
      ["코드를 수집하지 않음", "로컬 프록시는 토큰만 주입하고, 코드는 공식 서버로 직행합니다."],
      ["중개하지 않음", "요청 데이터는 Bingcha 서버를 거치지 않습니다."],
    ],
  },

  quickstart: {
    eyebrow: "/ 빠른 시작",
    title: "3단계, 30초면 시작",
    sub: "클라이언트 다운로드, 카드 입력, 원클릭 테이크오버. API Key 설정도 도구 교체도 필요 없습니다.",
    steps: [
      {
        t: "클라이언트 다운로드",
        d: "다운로드 페이지에서 시스템에 맞는 버전을 받으세요. Windows는 설치 불필요, macOS는 응용 프로그램 폴더로 드래그, Linux는 압축 해제 후 실행합니다.",
      },
      {
        t: "카드 입력",
        d: "클라이언트 실행 후 “계정 카드” 섹션에 리필 카드(형식 AI…)를 입력하고 “확인 및 활성화”를 클릭하세요. 카드는 bcai.store에서 구매할 수 있습니다.",
      },
      {
        t: "원클릭 테이크오버",
        d: "“테이크오버” 패널에서 원하는 제품(IDE / Hub / Codex / Claude Code)을 선택하고 스위치만 켜면 IDE 요청이 자동으로 로컬 프록시를 거칩니다.",
      },
    ],
    goDownload: "다운로드하러 가기 →",
    cardTitle: "카드 안내",
    cardWhatTitle: "카드란 무엇인가요?",
    cardWhat:
      "카드는 BingchaAI 이용 자격 증명으로, 형식은 AI…입니다. 카드마다 정해진 유효 기간과 지원 제품 범위가 있으며, 만료되면 새 카드를 구매해 연장할 수 있습니다.",
    cardBuyLabel: "구매처",
    cardBuyPre: "카드는 ",
    cardBuyPost: "에서 구매할 수 있습니다.",
    cardExpiryLabel: "만료일 확인",
    cardExpiry: "활성화 후 클라이언트에서 만료일을 확인할 수 있습니다.",
    cardRenewLabel: "연장",
    cardRenew: "만료 전 언제든 새 카드를 입력해 연장하면 끊김 없이 이어집니다.",
    cardPlanLabel: "플랜",
    cardPlan: "플랜에 따라 지원하는 제품 조합이 다릅니다 (Antigravity / Codex / Claude).",
    takeoverTitle: "테이크오버 패널",
    takeoverIntro: "BingchaAI는 5개 제품 대상을 각각 독립적으로 테이크오버하며, 모두 개별 스위치가 있습니다:",
    takeover: [
      ["Antigravity IDE", "Gemini, Claude 두 모델 자동 테이크오버, 네이티브와 동일한 경험"],
      ["Antigravity Hub", "Hub의 모든 AI 기능 커버, 다른 기능에는 영향 없음"],
      ["OpenAI Codex", "codex 명령 그대로 사용, Plus / Pro 쿼터 자동 획득"],
      ["Claude Code", "CLI와 VS Code 확장 모두 지원, Max / Pro 구독에 직접 연결"],
      ["Claude Desktop", "macOS / Windows 양 플랫폼 데스크톱 투명 테이크오버"],
    ],
    ctaTitle: "아직 카드가 없으신가요?",
    ctaSub: "Bingcha 스토어에서 리필 카드를 구매하세요. 다양한 플랜이 준비되어 있습니다.",
  },

  faqPage: {
    eyebrow: "/ 자주 묻는 질문",
    title: "자주 묻는 질문",
    sub: "사용 중 문제가 생겼나요? 여기서 답을 찾거나 고객 지원 위챗을 추가하세요.",
    contactTitle: "고객 지원",
    contactDesc: "상담원의 도움이 필요하신가요? 고객 지원 위챗을 추가하세요.",
    copy: "복사",
    copied: "복사됨",
    qrAlt: "고객 지원 위챗 QR 코드",
    scanToAdd: "스캔해서 추가",
    searchPlaceholder: "질문 검색…",
    searchAria: "자주 묻는 질문 검색",
    noMatch: "일치하는 질문이 없습니다.",
    empty: "아직 등록된 질문이 없습니다.",
    questionCount: "질문 {n}개",
  },









  statusLabels: {
    HEALTHY: "정상",
    LOGIN_REQUIRED: "로그인 필요",
    VERIFICATION_REQUIRED: "인증 필요",
    DISABLED: "비활성화됨",
    ACTIVE: "활성",
    MANUAL_ONLY: "수동 전용",
    PENDING: "대기 중",
    RUNNING: "실행 중",
    TASK_QUEUED: "처리 중",
    TASK_RUNNING: "작업 실행 중",
    CODE_VERIFIED: "코드 확인됨",
    GROUP_ASSIGNED: "그룹 배정됨",
    INVITE_SENT: "초대 발송됨",
    WAIT_USER_ACCEPT: "수락 대기",
    COMPLETED: "완료",
    FAILED: "실패",
    EXPIRED: "만료됨",
    CANCELLED: "취소됨",
    MANUAL_REVIEW: "수동 처리",
    REPLACED_AND_INVITE_SENT: "교체 후 초대 발송",
    FAILED_FINAL: "최종 실패",
    FAILED_RETRYABLE: "재시도 가능",
    INVITE_MEMBER: "멤버 초대",
    REMOVE_MEMBER: "멤버 제거",
    REPLACE_MEMBER: "멤버 교체",
    SYNC_FAMILY_GROUP: "패밀리 그룹 동기화",
    HEALTH_CHECK_ACCOUNT: "상태 점검",
    UNUSED: "미사용",
    USED: "사용됨",
    RESERVED: "예약됨",
    ACCEPTED: "수락됨",
    REMOVED: "제거됨",
    SENT: "발송됨",
    CREATED: "생성됨",
    SUSPENDED: "일시 중지됨",
    SUCCESS: "성공",
    RISKY: "위험",
    ADMIN: "관리자",
    OPERATIONS: "운영",
    SUPPORT: "고객 지원",
    OWNER: "오너 계정",
    MEMBER: "멤버",
    TOTP: "설정됨",
    "No TOTP": "미설정",
    GOOGLE_ONE: "Google One",
    REMOVING: "제거 중",
    INVITING: "초대 중",
    PARTIALLY_FAILED: "부분 실패",
    NOT_STARTED: "시작 전",
  },
};
