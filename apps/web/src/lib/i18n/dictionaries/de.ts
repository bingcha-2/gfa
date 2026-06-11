import type { DeepPartialDict } from "./types";

/** Deutsch — übersetzt anhand von en (Referenz) und zh-CN (Struktur); fehlende Schlüssel fallen zur Laufzeit auf zh-CN zurück. */
export const de: DeepPartialDict = {
  meta: {
    title: "BingchaAI — Nachfüllen per Klick für KI-Coding-Tools",
    description:
      "BingchaAI ist ein Desktop-Client, der Antigravity IDE, OpenAI Codex, Claude Code und andere KI-Coding-Tools mit echten offiziellen Abo-Konten übernimmt. Keine API-Schlüssel, keine Drosselung, kein Aufpreis.",
    faqTitle: "FAQ — BingchaAI",
    faqDescription:
      "Antworten auf häufige Fragen zu BingchaAI: Familiengruppen-Einladungen, Client-Übernahme, Zugangskarten und Kontingente.",
    featuresTitle: "Client-Funktionen — BingchaAI",
    featuresDescription:
      "Der BingchaAI-Desktop-Client: Live-Dashboard, Kontingent-Anzeigen pro Modell, Übernahme-Steuerung, Ersparnis-Tracking, alle Plattformen.",
    howTitle: "Funktionsweise — BingchaAI",
    howDescription:
      "Was BingchaAI zwischen Ihrem Rechner und den offiziellen APIs tut: Ein lokaler Proxy injiziert Token und verbindet Sie direkt mit offiziellen Servern — kein Mittelsmann.",
    quickstartTitle: "Schnellstart — BingchaAI",
    quickstartDescription:
      "In drei Schritten mit BingchaAI starten: Client herunterladen, Zugangskarte eingeben, mit einem Klick übernehmen. In unter 30 Sekunden.",
    downloadTitle: "Download — BingchaAI",
    downloadDescription:
      "Laden Sie den BingchaAI-Desktop-Client für Windows, macOS und Linux herunter. Nachfüllen per Klick — einfach Zugangskarte eingeben.",
  },

  common: {
    downloadClient: "Client herunterladen",
    buyCard: "Zugangskarte kaufen ↗",
    brandName: "BingchaAI",
  },

  nav: {
    features: "Funktionen",
    howItWorks: "Funktionsweise",
    quickstart: "Schnellstart",
    faq: "FAQ",
    menu: "Menü",
    mainNav: "Hauptnavigation",
    toggleTheme: "Helles / dunkles Design umschalten",
  },

  footer: {
    desc: "Übernahme offizieller Konten für gängige KI-Coding-Tools. Direkt zu offiziellen Servern — kein Mittelsmann.",
    product: "Produkt",
    download: "Client herunterladen",
    features: "Funktionen",
    quickstart: "Schnellstart",
    howItWorks: "Funktionsweise",
    help: "Hilfe",
    faq: "FAQ",
    store: "Bingcha Store ↗",
    api: "Bingcha API ↗",
    terminal: "Bingcha Terminal ↗",
    copyright: "© 2026 BingchaAI",
    tagline: "Offizielle Direktverbindung · Kein Mittelsmann · Ihr Code berührt uns nie",
  },

  mock: {
    proxyStatus: "Proxy",
    running: "Läuft",
    todayRequests: "Anfragen heute",
    errors: "Fehler",
    inputTokens: "Input-Token",
    outputTokens: "Output-Token",
    takeoverStatus: "Übernahme",
    takenOver: "Aktiv",
    notTakenOver: "Aus",
    modelQuota: "Modell-Kontingent",
  },

  home: {
    eyebrow: "/ Übernahme offizieller Konten, Nachfüllen per Klick",
    h1Line1: "Verbinden Sie Ihre KI-Coding-Tools",
    h1Line2Prefix: "direkt mit ",
    h1Line2Accent: "offiziellen Konten",
    sub: "BingchaAI weist Ihnen echte offizielle Abo-Konten zu, sodass Antigravity, Claude Code und Codex CLI wie gewohnt direkt mit offiziellen Servern sprechen — keine API-Schlüssel, kein Tool-Wechsel, kein Ärger mit Risikokontrollen.",
    trust1: "Offizielle Direktverbindung",
    trust2: "Kein Mittelsmann",
    trust3: "Ihr Code berührt uns nie",
    ecosystemsTitle: "Ein Client, drei Ökosysteme",
    ecosystemsLead:
      "Gängige KI-Coding-Tools funktionieren sofort. Nach der Übernahme nutzen Sie sie wie gewohnt — Modell-Anfragen laufen automatisch über den Bingcha-Konto-Pool.",
    ecosystems: [
      {
        name: "Antigravity",
        tag: "IDE · Hub",
        desc: "Googles KI-Coding-IDE. Nach der Übernahme laufen Gemini- / Claude-Anfragen über den Bingcha-Pool — der Editor merkt nichts davon.",
      },
      {
        name: "OpenAI Codex",
        tag: "CLI",
        desc: "OpenAIs KI-Coding-Agent. Holt ChatGPT-Plus-/Pro-Token automatisch — der codex-Befehl funktioniert einfach, ganz ohne API-Schlüssel.",
      },
      {
        name: "Claude Code",
        tag: "CLI · VSCode · Desktop",
        desc: "Claude Code CLI, VS-Code-Erweiterung und macOS-Desktop-App, direkt mit Max- / Pro-Abos verbunden. Kontingent aufgebraucht? Automatisch nachgefüllt.",
      },
    ],
    logoAlt: "Logo von {name}",
    howTitle: "Token lokal injiziert, offiziell verbunden",
    howLead:
      "Echte offizielle Token werden in die Tools auf Ihrem Rechner injiziert, Ihr Code geht direkt an offizielle Endpunkte. Bingcha tauscht Token nur in einer lokalen Proxy-Schicht — niemals als Mittelsmann.",
    how: [
      {
        t: "Lokalen Proxy starten",
        d: "Ein leichtgewichtiger Proxy startet auf Ihrem Rechner und übernimmt jedes Tool auf dem Standardweg — keine Code-Änderungen, mit einem Klick vollständig umkehrbar.",
      },
      {
        t: "Offizielle Konten bei Bedarf leihen",
        d: "Sobald ein Tool eine Anfrage sendet, wird in Echtzeit ein echtes offizielles Token aus dem Pool geliehen — fast ohne zusätzliche Latenz.",
      },
      {
        t: "Token tauschen, direkt verbinden",
        d: "Das Platzhalter-Token wird durch ein echtes ersetzt und die Anfrage geht direkt an offizielle Endpunkte. Ihr Code läuft nie über Bingcha.",
      },
      {
        t: "Live-Statistik, automatischer Wechsel",
        d: "Die Nutzung wird gezählt, während Antworten zurückströmen. Ist das Kontingent erschöpft oder wird ein Konto markiert, wechselt das System automatisch auf ein Ersatzkonto.",
      },
    ],
    quickstartLabel: "Schnellstart",
    quickstartSteps: ["Client herunterladen", "Zugangskarte eingeben", "Auf „Übernehmen“ klicken"],
    quickstartNote: "Unter 30 Sekunden — dann coden wie gewohnt",
    capsTitle: "Wir halten die Konto-Pool-Komplexität von Ihnen fern",
    capsLead:
      "Ein einzelnes Konto läuft leer, wird markiert, ist überlastet. Intelligente Zuteilung, fester Ausgang und Risiko-Isolation lassen Sie einfach Code schreiben.",
    caps: [
      {
        t: "Intelligente Pool-Zuteilung",
        d: "Keine Zufallsvergabe. Konten werden nach Affinität, Auslastung, Tarifstufe und verbleibendem Kontingent pro Modell bewertet — Sie erhalten stets das aktuell beste Konto.",
      },
      {
        t: "Geteiltes oder exklusives Kontingent — Ihre Wahl",
        d: "Pool-Karten teilen Konten zwischen Nutzern zum besten Preis; gebundene Karten erhalten ein exklusives Konto mit stabilerem Kontingent. Geteilte Konten nutzen einen Fair-Share-Algorithmus, damit jeder seinen Anteil bekommt — niemand kann alles belegen.",
      },
      {
        t: "Fester Ausgang, isoliertes Risiko",
        d: "Optionale feste Residential-Ausgangs-IPs halten Verbindungen stabil und lösen kaum Risikokontrollen aus. Fällt ein Konto aus, wird nur dieses isoliert — es wird automatisch ersetzt, ohne andere Nutzer zu beeinträchtigen.",
      },
      {
        t: "Live-Kontingent-Anzeigen",
        d: "Token werden beim Streamen der Antworten gezählt und spiegeln das 5-Stunden-Fenster des Servers lokal. Jedes Modell zeigt sein Restkontingent samt echter Reset-Zeit — Nutzung und Ersparnis auf einen Blick.",
      },
      {
        t: "Ein-Klick-Übernahme, null Konfiguration",
        d: "Client öffnen → Zugangskarte eingeben → auf „Übernehmen“ klicken. Keine API-Schlüssel, kein Tool-Wechsel, nichts Neues zu lernen — und ein Klick stellt alles wieder her.",
      },
    ],
    compareTitle: "Warum BingchaAI",
    compareLead:
      "Im Vergleich zum eigenen Abo oder zu API-Relays punktet Bingcha bei Abdeckung, Stabilität und Komfort.",
    compareColUs: "BingchaAI",
    compareColOwn: "Selbst abonnieren",
    compareColRelay: "API-Relay",
    compareRows: [
      ["Echte offizielle Abo-Konten", "Ja", "Ja", "Nein (API-Schlüssel)"],
      ["Native Geschwindigkeit", "Ja", "Ja", "Evtl. gedrosselt"],
      ["Produktabdeckung", "3 Ökosysteme", "Je ein Abo", "Je nach Relay"],
      ["Auto-Wechsel / Sperr-Fallback", "Automatisch", "Selbst zuständig", "Selbst zuständig"],
      ["Einrichtungsaufwand", "Null Konfiguration", "Manuell", "Keys + Konfig-Änderungen"],
      ["Nutzungsübersicht", "Dashboard", "Keine", "Je nach Relay"],
    ],
    trustTitle: "Ihr Code berührt uns nie",
    trustLead:
      "Der BingchaAI-Client läuft auf Ihrem eigenen Rechner und tut genau eines: Autorisierungs-Token in Ihre Tools injizieren.",
    trustPoints: [
      {
        b: "Keine API-Schlüssel versendet",
        s: "Der Client injiziert nur Autorisierungs-Token — keine Geheimnisse gelangen je an Dritte.",
      },
      {
        b: "Keine IDE-Konfig-Änderungen",
        s: "Editor, Plugins und Workflow bleiben unangetastet; die Übernahme lässt sich mit einem Klick beenden.",
      },
      {
        b: "Keine Code-Sammlung",
        s: "Code geht direkt an offizielle Server. Bingcha ist kein Mittelsmann-Proxy und speichert nichts.",
      },
    ],
    ctaTitle: "Bereit zum Nachfüllen?",
    ctaSub: "Laden Sie den BingchaAI-Client herunter oder holen Sie sich zuerst eine Zugangskarte im Store — in 30 Sekunden coden Sie wie gewohnt.",
  },

  download: {
    eyebrow: "/ Downloads",
    title: "BingchaAI-Client herunterladen",
    sub: "Nachfüllen per Klick, keine IDE-Plugins. Nach dem Download direkt starten und Zugangskarte eingeben.",
    recommended: "Empfohlen",
    winMeta: "Windows 10 / 11 (64-bit) · v{version} · {size} MB",
    winHint: "Keine Installation — einfach per Doppelklick starten.",
    downloadNow: "Jetzt herunterladen",
    macMeta: "macOS 12+ · v{version}",
    macHint: "Erster Start: Rechtsklick auf die App → Öffnen → bestätigen.",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    linuxMeta: "x86_64 · v{version}",
    downloadTar: "tar.gz herunterladen",
    linuxHint: "Entpacken, chmod +x, starten.",
    changelogTitle: "Neu in v{version}",
    guideTitle: "Erste Schritte",
    steps: [
      "BingchaAI herunterladen und direkt starten (Windows ohne Installation; auf macOS in „Programme“ ziehen).",
      "Zugangskarte zum Nachfüllen eingeben — oder in den lokalen Pool-Modus wechseln und eigene Konten hinzufügen.",
      "Auf „Übernehmen“ klicken und Antigravity / Claude Code / Codex wie gewohnt weiterverwenden.",
    ],
    autoUpdateNote: "Der Client aktualisiert sich automatisch — nach dem ersten Download sind keine manuellen Upgrades nötig.",
  },

  features: {
    eyebrow: "/ Client-Funktionen",
    title: "Jeden KI-Aufruf im Griff",
    sub: "Ein nativer Desktop-Client mit integriertem Dashboard — Nutzung, Kontingente und Übernahme-Status stets im Blick.",
    shotAlt: "BingchaAI-Client-Konsole mit Anfragestatistik, Kontingent-Anzeigen pro Modell und Übernahme-Status",
    shotCaption: "Client-Konsole — Anfragestatistik, Modellnutzung und Übernahme-Status in Echtzeit",
    dashTitle: "Live-Dashboard",
    dash: [
      { t: "Anfragen heute", d: "Alle KI-Modell-Anfragen in Echtzeit — bis auf den einzelnen Aufruf genau." },
      { t: "Fehler-Tracking", d: "Fehlgeschlagene Anfragen werden erfasst, damit Sie Probleme schnell erkennen." },
      { t: "Input- / Output-Token", d: "Gesendete und empfangene Token, getrennt gezählt." },
      {
        t: "Gespartes Geld",
        d: "Live berechnet aus tatsächlichen Modellen und offiziellen Abo-Preisen — eine markante grüne Zahl zeigt den Wert auf einen Blick.",
      },
    ],
    quotaTitle: "Kontingent-Anzeigen pro Modell",
    quotaIntroPre: "Der Client bringt ",
    quotaIntroStrong: "Live-Kontingent-Anzeigen",
    quotaIntroPost: " für jedes Modell mit. Verschiedene Produkte nutzen unterschiedliche Kontingent-Fenster:",
    models: [
      {
        name: "Claude (Anthropic)",
        win: "5-Stunden- + Wochenfenster",
        desc: "Beide Fenster werden unabhängig verfolgt, die Anzeigen aktualisieren sich live — samt Countdown bis zum Kontingent-Reset.",
      },
      {
        name: "Codex (OpenAI)",
        win: "5-Stunden- + Wochenfenster",
        desc: "Doppel-Fenster-Tracking, das ChatGPT-Plus-/Pro-Kontingente präzise abbildet.",
      },
      {
        name: "Gemini (Google)",
        win: "Einzelner Kontingent-Pool",
        desc: "Gemini-Nutzung in der Antigravity IDE, angezeigt als verbraucht / gesamt.",
      },
    ],
    resetNoteTitle: "Countdown bis zum Kontingent-Reset",
    resetNote: "Wird das Kontingent knapp, zeigt die Anzeige, wann es sich erholt — so planen Sie Ihre Arbeit darum herum.",
    takeoverTitle: "Übernahme-Steuerung",
    takeoverIntroPre: "Jedes Produkt hat einen eigenen Schalter — ",
    takeoverIntroStrong: "übernehmen Sie genau die Tools, die Sie möchten",
    takeoverIntroPost: "; alles andere bleibt nativ und unberührt.",
    takeover: [
      { name: "Antigravity IDE", s: "Gemini + Claude, beide Modelle" },
      { name: "Antigravity Hub", s: "Alle KI-Funktionen abgedeckt" },
      { name: "OpenAI Codex", s: "Plus- / Pro-Kontingent, direkt" },
      { name: "Claude Code", s: "CLI + VS-Code-Erweiterung" },
      { name: "Claude Desktop", s: "macOS / Windows" },
    ],
    moreTitle: "Weitere Highlights",
    more: [
      { t: "Auto-Updates", d: "Integriertes OTA: Neue Versionen laden und installieren sich selbst." },
      { t: "Ankündigungen", d: "Betriebs- und Wartungshinweise, live zugestellt." },
      { t: "Anfrage-Logs", d: "Jede Anfrage protokolliert mit Zeit, Modell und Statuscode." },
      { t: "Pfad-Erkennung", d: "Installationspfade von IDE / Hub / Codex werden automatisch erkannt — oder manuell gesetzt." },
      { t: "Alle Plattformen", d: "Windows · macOS (Intel + Apple Silicon) · Linux." },],
    settingsTitle: "Einstellungen",
    settings: [
      ["IDE-Pfad", "Installationsverzeichnis der Antigravity IDE — automatisch erkannt oder manuell gewählt."],
      ["Hub-Pfad", "Installationsverzeichnis des Antigravity Hub, ebenfalls automatisch erkannt."],
      ["Codex-Pfad", "Installationspfad der Codex CLI."],],
    ctaTitle: "Selbst ausprobieren?",
    ctaSub: "Laden Sie den BingchaAI-Client herunter und erleben Sie diese Funktionen live.",
  },

  how: {
    eyebrow: "/ Funktionsweise",
    title: "Token lokal injiziert, offiziell verbunden",
    sub: "Was genau BingchaAI zwischen Ihrem Rechner und den offiziellen APIs tut.",
    archTitle: "Architektur im Überblick",
    archP1Pre: "BingchaAI betreibt einen ",
    archP1Strong1: "leichtgewichtigen lokalen Proxy",
    archP1Mid: " auf Ihrem Rechner. Es ist kein Cloud-Relay — Ihr Code und Ihre KI-Konversationen ",
    archP1Strong2: "laufen nie über unsere Server",
    archP1Post: ", sondern gehen direkt an die offiziellen API-Endpunkte von Google, OpenAI und Anthropic.",
    coreNoteTitle: "Kernprinzip",
    coreNote:
      "BingchaAI tut genau eines: das richtige offizielle Abo-Token in Ihre Anfragen injizieren. Kein Umschreiben von Anfragen, kein Antwort-Caching, kein Code-Logging — eine reine Token-Injektionsschicht.",
    lifecycleTitle: "Lebenszyklus einer Anfrage",
    flow: [
      {
        t: "Anfrage abfangen",
        d: "Ein lokaler Proxy (127.0.0.1) fängt Anfragen der IDE an offizielle Server transparent ab. Claude Code per Umgebungsvariablen, Codex per Provider-Wechsel, Claude Desktop über einen lokalen MITM-Proxy.",
      },
      {
        t: "Konto bei Bedarf leihen",
        d: "Die Leasing-Engine holt in Echtzeit ein echtes offizielles Konto-Token (samt Kontingent und Ablaufzeit) aus dem Pool — paralleles Deduplizieren und Token-Caching halten die Latenz nahe null.",
      },
      {
        t: "Tauschen und direkt senden",
        d: "Der Proxy ersetzt das Platzhalter-Token durch das echte und sendet die Anfrage direkt an api.anthropic.com / chatgpt.com — optional über einen festen Residential-Ausgang.",
      },
      {
        t: "Zurückstreamen",
        d: "Die offizielle Antwort streamt unverändert zurück zur IDE, die Token-Nutzung wird dabei mitgezählt. Das Erlebnis ist identisch mit einem nativen Abo.",
      },
    ],
    poolTitle: "Pool-Rotation",
    poolIntro:
      "Bingcha unterhält einen Pool echter offizieller Abo-Konten. Ihr Client leiht sich dynamisch ein verfügbares Konto:",
    pool: [
      { t: "Auto-Verlängerung", d: "Token verlängern sich, solange sie gültig sind, und übergeben vor Ablauf nahtlos." },
      { t: "Wechsel bei leerem Kontingent", d: "Ist das aktuelle Konto erschöpft, wird auf ein anderes Konto mit Restkontingent gewechselt." },
      {
        t: "Risiko-Isolation",
        d: "Ein von der Plattform markiertes Konto wird sofort als unbrauchbar gekennzeichnet und aus dem Pool genommen — andere Nutzer bleiben unberührt.",
      },
      { t: "Auto-Nachschub", d: "Neue Konten werden laufend in den Pool aufgenommen, damit der Vorrat gesund bleibt." },
    ],
    productsTitle: "Übernahme pro Produkt",
    products: [
      {
        name: "Antigravity (IDE · Hub)",
        items: [
          "Gemini und Claude werden beide automatisch übernommen",
          "IDE- / Hub-Erlebnis identisch mit nativem Abo",
          "Beim Beenden der Übernahme wird der Originalzustand automatisch wiederhergestellt",
        ],
      },
      {
        name: "OpenAI Codex CLI",
        items: [
          "Der codex-Befehl funktioniert einfach — kein manuelles Token-Holen",
          "ChatGPT-Plus-/Pro-Kontingent wird automatisch bezogen",
          "Identisch mit dem offiziellen CLI-Erlebnis",
        ],
      },
      {
        name: "Claude Code · Desktop",
        items: [
          "CLI, VS-Code-Erweiterung und macOS-/Windows-Desktop-Apps",
          "Keine Claude-Konfigurationsdateien angefasst — Wiederherstellung mit einem Klick",
          "Direkter Zugriff auf das Max- / Pro-Abo-Kontingent",
        ],
      },
    ],
    safetyTitle: "Sicherheitsmodell",
    safetyHeadline: "Unsere Sicherheitsversprechen",
    safetyLead: "Code geht direkt an offizielle Server; der lokale Proxy injiziert nur Token.",
    safe: [
      ["Keine API-Schlüssel versendet", "Offizielles Abo-Kontingent — kein API-Relaying."],
      ["Keine IDE-Konfig-Änderungen", "Die Originalkonfiguration wird beim Beenden automatisch wiederhergestellt."],
      ["Keine Code-Sammlung", "Der lokale Proxy injiziert nur Token; Code geht direkt an offizielle Server."],
      ["Kein Mittelsmann", "Anfragedaten laufen nie über Bingcha-Server."],
    ],
  },

  quickstart: {
    eyebrow: "/ Schnellstart",
    title: "Drei Schritte, 30 Sekunden",
    sub: "Client herunterladen, Zugangskarte eingeben, mit einem Klick übernehmen. Keine API-Schlüssel, kein Tool-Wechsel.",
    steps: [
      {
        t: "Client herunterladen",
        d: "Holen Sie sich auf der Download-Seite den Build für Ihr System. Windows braucht keine Installation, macOS in „Programme“ ziehen, Linux entpacken und starten.",
      },
      {
        t: "Zugangskarte eingeben",
        d: "Starten Sie den Client, geben Sie unter „Zugangskarte“ Ihre Karte zum Nachfüllen ein (Format AI…) und klicken Sie auf „Prüfen & aktivieren“. Karten gibt es auf bcai.store.",
      },
      {
        t: "Mit einem Klick übernehmen",
        d: "Wählen Sie im Übernahme-Panel die Produkte aus (IDE / Hub / Codex / Claude Code) und legen Sie den Schalter um — IDE-Anfragen laufen automatisch über den lokalen Proxy.",
      },
    ],
    goDownload: "Zu den Downloads →",
    cardTitle: "Über Zugangskarten",
    cardWhatTitle: "Was ist eine Zugangskarte?",
    cardWhat:
      "Die Zugangskarte ist Ihr BingchaAI-Berechtigungsnachweis im Format AI…. Jede Karte hat eine feste Laufzeit und Produktabdeckung; zum Verlängern kaufen Sie nach Ablauf einfach eine neue.",
    cardBuyLabel: "Wo kaufen",
    cardBuyPre: "Karten gibt es auf ",
    cardBuyPost: ".",
    cardExpiryLabel: "Ablauf prüfen",
    cardExpiry: "Nach der Aktivierung zeigt der Client das Ablaufdatum an.",
    cardRenewLabel: "Verlängerung",
    cardRenew: "Geben Sie jederzeit vor Ablauf eine neue Karte ein — der Übergang ist nahtlos.",
    cardPlanLabel: "Tarife",
    cardPlan: "Verschiedene Tarife decken verschiedene Produktkombinationen ab (Antigravity / Codex / Claude).",
    takeoverTitle: "Übernahme-Panel",
    takeoverIntro: "BingchaAI übernimmt 5 Produktziele unabhängig voneinander, jedes mit eigenem Schalter:",
    takeover: [
      ["Antigravity IDE", "Gemini und Claude werden automatisch übernommen — natives Erlebnis"],
      ["Antigravity Hub", "Alle KI-Funktionen im Hub abgedeckt, sonst bleibt alles unberührt"],
      ["OpenAI Codex", "Der codex-Befehl funktioniert einfach, mit Plus- / Pro-Kontingent"],
      ["Claude Code", "CLI und VS-Code-Erweiterung, verbunden mit Max- / Pro-Abos"],
      ["Claude Desktop", "Transparente Übernahme auf macOS und Windows"],
    ],
    ctaTitle: "Noch keine Zugangskarte?",
    ctaSub: "Holen Sie sich eine im Bingcha Store — mehrere Tarife verfügbar.",
  },

  faqPage: {
    eyebrow: "/ FAQ",
    title: "Häufig gestellte Fragen",
    sub: "Ein Problem? Hier finden Sie Antworten — oder fügen Sie unseren Support auf WeChat hinzu.",
    contactTitle: "Support",
    contactDesc: "Persönliche Hilfe nötig? Fügen Sie unseren Support auf WeChat hinzu.",
    copy: "Kopieren",
    copied: "Kopiert",
    qrAlt: "WeChat-QR-Code des Supports",
    scanToAdd: "Zum Hinzufügen scannen",
    searchPlaceholder: "Fragen durchsuchen…",
    searchAria: "FAQ durchsuchen",
    noMatch: "Keine passenden Fragen.",
    empty: "Noch keine FAQ-Einträge.",
    questionCount: "{n} Fragen",
  },









  statusLabels: {
    HEALTHY: "Gesund",
    LOGIN_REQUIRED: "Anmeldung nötig",
    VERIFICATION_REQUIRED: "Verifizierung nötig",
    DISABLED: "Deaktiviert",
    ACTIVE: "Aktiv",
    MANUAL_ONLY: "Nur manuell",
    PENDING: "Ausstehend",
    RUNNING: "Läuft",
    TASK_QUEUED: "In Bearbeitung",
    TASK_RUNNING: "Aufgabe läuft",
    CODE_VERIFIED: "Code geprüft",
    GROUP_ASSIGNED: "Gruppe zugewiesen",
    INVITE_SENT: "Einladung versendet",
    WAIT_USER_ACCEPT: "Wartet auf Annahme",
    COMPLETED: "Abgeschlossen",
    FAILED: "Fehlgeschlagen",
    EXPIRED: "Abgelaufen",
    CANCELLED: "Storniert",
    MANUAL_REVIEW: "Manuelle Prüfung",
    REPLACED_AND_INVITE_SENT: "Gewechselt & eingeladen",
    FAILED_FINAL: "Endgültig fehlgeschlagen",
    FAILED_RETRYABLE: "Wiederholbar",
    INVITE_MEMBER: "Mitglied einladen",
    REMOVE_MEMBER: "Mitglied entfernen",
    REPLACE_MEMBER: "Mitglied ersetzen",
    SYNC_FAMILY_GROUP: "Familiengruppe synchronisieren",
    HEALTH_CHECK_ACCOUNT: "Gesundheitsprüfung",
    UNUSED: "Unbenutzt",
    USED: "Benutzt",
    RESERVED: "Reserviert",
    ACCEPTED: "Angenommen",
    REMOVED: "Entfernt",
    SENT: "Versendet",
    CREATED: "Erstellt",
    SUSPENDED: "Pausiert",
    SUCCESS: "Erfolgreich",
    RISKY: "Gefährdet",
    ADMIN: "Admin",
    OPERATIONS: "Betrieb",
    SUPPORT: "Support",
    OWNER: "Hauptkonto",
    MEMBER: "Mitglied",
    TOTP: "Eingerichtet",
    "No TOTP": "Nicht eingerichtet",
    GOOGLE_ONE: "Google One",
    REMOVING: "Wird entfernt",
    INVITING: "Wird eingeladen",
    PARTIALLY_FAILED: "Teilweise fehlgeschlagen",
    NOT_STARTED: "Nicht gestartet",
  },
};
