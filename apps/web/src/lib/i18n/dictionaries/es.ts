import type { DeepPartialDict } from "./types";

/** Español — traducción neutra (Latinoamérica), basada en zh-CN/en. */
export const es: DeepPartialDict = {
  meta: {
    title: "BingchaAI — Recarga con un clic para herramientas de programación con IA",
    description:
      "BingchaAI es un cliente de escritorio que toma el control de Antigravity IDE, OpenAI Codex, Claude Code y otras herramientas de programación con IA usando cuentas de suscripción oficiales reales. Sin API Key, sin ralentización, sin sobreprecio.",
    faqTitle: "Preguntas frecuentes — BingchaAI",
    faqDescription:
      "Respuestas a las dudas más comunes sobre BingchaAI: invitaciones al grupo familiar, toma de control del cliente, tarjetas de acceso y cuotas.",
    featuresTitle: "Funciones del cliente — BingchaAI",
    featuresDescription:
      "El cliente de escritorio de BingchaAI: panel en vivo, barras de cuota por modelo, controles de toma de control, seguimiento de ahorro, todas las plataformas.",
    howTitle: "Cómo funciona — BingchaAI",
    howDescription:
      "Qué hace BingchaAI entre tu equipo y las API oficiales: un proxy local inyecta tokens y te conecta directo a los servidores oficiales — sin intermediarios.",
    quickstartTitle: "Inicio rápido — BingchaAI",
    quickstartDescription:
      "Empieza con BingchaAI en tres pasos: descarga el cliente, ingresa tu tarjeta de acceso y toma el control con un clic. Menos de 30 segundos.",
    downloadTitle: "Descargas — BingchaAI",
    downloadDescription:
      "Descarga el cliente de escritorio de BingchaAI para Windows, macOS y Linux. Recarga con un clic: solo ingresa tu tarjeta de acceso.",
  },

  common: {
    downloadClient: "Descargar cliente",
    buyCard: "Comprar tarjeta de acceso ↗",
    brandName: "BingchaAI",
  },

  nav: {
    features: "Funciones",
    howItWorks: "Cómo funciona",
    quickstart: "Inicio rápido",
    faq: "Preguntas frecuentes",
    menu: "Menú",
    mainNav: "Navegación principal",
    toggleTheme: "Cambiar tema claro / oscuro",
  },

  footer: {
    desc: "Toma de control con cuentas oficiales para las principales herramientas de programación con IA. Directo a los servidores oficiales — sin intermediarios.",
    product: "Producto",
    download: "Descargar cliente",
    features: "Funciones",
    quickstart: "Inicio rápido",
    howItWorks: "Cómo funciona",
    help: "Ayuda",
    faq: "Preguntas frecuentes",
    store: "Tienda Bingcha ↗",
    api: "Bingcha API ↗",
    terminal: "Terminal Bingcha ↗",
    copyright: "© 2026 BingchaAI",
    tagline: "Conexión oficial directa · Sin intermediarios · Tu código nunca pasa por nosotros",
  },

  mock: {
    proxyStatus: "Proxy",
    running: "Activo",
    todayRequests: "Solicitudes hoy",
    errors: "Errores",
    inputTokens: "Tokens de entrada",
    outputTokens: "Tokens de salida",
    takeoverStatus: "Toma de control",
    takenOver: "Activa",
    notTakenOver: "Inactiva",
    modelQuota: "Cuota por modelo",
  },

  home: {
    eyebrow: "/ Toma de control con cuentas oficiales, recarga con un clic",
    h1Line1: "Conecta tus herramientas de IA",
    h1Line2Prefix: "directo a las ",
    h1Line2Accent: "cuentas oficiales",
    sub: "BingchaAI te asigna cuentas de suscripción oficiales reales para que Antigravity, Claude Code y Codex CLI sigan hablando directo con los servidores oficiales — sin API Key, sin cambiar de herramienta, sin lidiar con el control de riesgos.",
    trust1: "Conexión oficial directa",
    trust2: "Sin intermediarios",
    trust3: "Tu código nunca pasa por nosotros",
    ecosystemsTitle: "Un cliente, tres ecosistemas",
    ecosystemsLead:
      "Las principales herramientas de programación con IA funcionan desde el primer momento. Tras la toma de control las usas como siempre: las solicitudes a los modelos se enrutan automáticamente por el pool de cuentas de Bingcha.",
    ecosystems: [
      {
        name: "Antigravity",
        tag: "IDE · Hub",
        desc: "El IDE de programación con IA de Google. Con el control tomado, las solicitudes a Gemini / Claude pasan por el pool de Bingcha — el editor ni lo nota.",
      },
      {
        name: "OpenAI Codex",
        tag: "CLI",
        desc: "El agente de programación de OpenAI. Obtiene tokens de ChatGPT Plus / Pro automáticamente: el comando codex simplemente funciona, sin tocar API Key.",
      },
      {
        name: "Claude Code",
        tag: "CLI · VSCode · Desktop",
        desc: "Claude Code CLI, la extensión de VS Code y la app de escritorio para macOS, conectados directo a suscripciones Max / Pro. ¿Se agota la cuota? Recarga automática.",
      },
    ],
    logoAlt: "Logo de {name}",
    howTitle: "Tokens inyectados en local, conexión oficial directa",
    howLead:
      "Los tokens oficiales reales se inyectan en las herramientas de tu equipo y tu código va directo a los endpoints oficiales. Bingcha solo intercambia tokens en una capa de proxy local — nunca actúa de intermediario.",
    how: [
      {
        t: "Se inicia un proxy local",
        d: "Un proxy ligero arranca en tu equipo y toma el control de cada herramienta por la vía estándar — sin tocar código y totalmente reversible con un clic.",
      },
      {
        t: "Cuentas oficiales alquiladas bajo demanda",
        d: "En cuanto una herramienta envía una solicitud, se alquila en tiempo real un token oficial real del pool, casi sin sumar latencia.",
      },
      {
        t: "Se intercambia el token y va directo",
        d: "El token provisional se reemplaza por uno real y la solicitud va directo a los endpoints oficiales. Tu código nunca pasa por Bingcha.",
      },
      {
        t: "Estadísticas en vivo, rotación automática",
        d: "El uso se contabiliza mientras las respuestas se transmiten. Si la cuota se agota o una cuenta queda marcada, se cambia automáticamente a una cuenta de reserva.",
      },
    ],
    quickstartLabel: "Inicio rápido",
    quickstartSteps: ["Descarga el cliente", "Ingresa tu tarjeta de acceso", "Haz clic en Tomar el control"],
    quickstartNote: "Menos de 30 segundos — y a programar como siempre",
    capsTitle: "Mantenemos la complejidad del pool de cuentas lejos de ti",
    capsLead:
      "Una sola cuenta se agota, queda marcada por riesgo, se satura. Asignación inteligente, salida fija y aislamiento de riesgos para que tú solo escribas código.",
    caps: [
      {
        t: "Asignación inteligente del pool",
        d: "No es asignación aleatoria. Las cuentas se puntúan por afinidad, carga, nivel de plan y cuota restante por modelo — siempre recibes la mejor cuenta disponible en ese momento.",
      },
      {
        t: "Cuota compartida o dedicada — tú eliges",
        d: "Las tarjetas de pool comparten cuentas entre usuarios al mejor precio; las tarjetas vinculadas tienen cuenta dedicada con cuota más estable. Las cuentas compartidas usan un algoritmo de reparto justo para que cada quien reciba su parte — nadie puede acapararla.",
      },
      {
        t: "Salida fija, riesgo aislado",
        d: "IP residenciales de salida fija opcionales mantienen la conexión estable y reducen la probabilidad de activar el control de riesgos. Si una cuenta falla, solo esa cuenta entra en cuarentena: se rota y reemplaza sin afectar a nadie más.",
      },
      {
        t: "Barras de cuota en vivo",
        d: "Los tokens se cuentan mientras las respuestas se transmiten, replicando en local la ventana deslizante de 5 horas del servidor. Cada modelo muestra la cuota restante según su hora real de reinicio — uso y ahorro de un vistazo.",
      },
      {
        t: "Toma de control con un clic, cero configuración",
        d: "Abre el cliente → ingresa tu tarjeta de acceso → haz clic en Tomar el control. Sin API Key, sin cambiar de herramienta, nada nuevo que aprender — y un clic lo restaura todo.",
      },
    ],
    compareTitle: "Por qué BingchaAI",
    compareLead:
      "Frente a suscribirte por tu cuenta o usar relays de API, Bingcha gana en cobertura, estabilidad y tranquilidad.",
    compareColUs: "BingchaAI",
    compareColOwn: "Suscripción propia",
    compareColRelay: "Relay de API",
    compareRows: [
      ["Cuentas de suscripción oficiales reales", "Sí", "Sí", "No (API Key)"],
      ["Velocidad nativa", "Sí", "Sí", "Puede estar limitada"],
      ["Cobertura multiproducto", "3 ecosistemas", "Una por producto", "Según el relay"],
      ["Rotación automática / respaldo ante bloqueos", "Automático", "Por tu cuenta", "Por tu cuenta"],
      ["Complejidad de configuración", "Cero configuración", "Manual", "Keys + editar config"],
      ["Visibilidad de uso", "Panel", "Ninguna", "Según el relay"],
    ],
    trustTitle: "Tu código nunca pasa por nosotros",
    trustLead:
      "El cliente de BingchaAI se ejecuta en tu propio equipo y hace exactamente una cosa: inyectar tokens de autorización en tus herramientas.",
    trustPoints: [
      {
        b: "Sin envío de API Key",
        s: "El cliente solo inyecta tokens de autorización — ningún secreto se expone a terceros.",
      },
      {
        b: "Sin cambios en la config del IDE",
        s: "Tu editor, plugins y flujo de trabajo quedan intactos, y la toma de control se desactiva con un clic.",
      },
      {
        b: "Sin recolección de código",
        s: "El código va directo a los servidores oficiales. Bingcha no es un proxy intermediario y no almacena nada.",
      },
    ],
    ctaTitle: "¿Listo para recargar?",
    ctaSub: "Descarga el cliente de BingchaAI o consigue primero una tarjeta de acceso en la tienda — en 30 segundos estarás programando como siempre.",
  },

  download: {
    eyebrow: "/ Descargas",
    title: "Descarga el cliente de BingchaAI",
    sub: "Recarga con un clic, sin plugins de IDE. Ejecútalo recién descargado e ingresa tu tarjeta de acceso.",
    recommended: "Recomendado",
    winMeta: "Windows 10 / 11 (64-bit) · v{version} · {size} MB",
    winHint: "Sin instalador — solo haz doble clic para ejecutarlo.",
    downloadNow: "Descargar ahora",
    macMeta: "macOS 12+ · v{version}",
    macHint: "Primera apertura: clic derecho en la app → Abrir → confirmar.",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    linuxMeta: "x86_64 · v{version}",
    downloadTar: "Descargar tar.gz",
    linuxHint: "Extrae, chmod +x y ejecuta.",
    changelogTitle: "Novedades de v{version}",
    guideTitle: "Primeros pasos",
    steps: [
      "Descarga BingchaAI y ejecútalo directamente (sin instalador en Windows; arrastra a Aplicaciones en macOS).",
      "Ingresa tu tarjeta de acceso de recarga, o cambia al modo de pool local y agrega tus propias cuentas.",
      "Haz clic en “Tomar el control” y sigue usando Antigravity / Claude Code / Codex como siempre.",
    ],
    autoUpdateNote: "El cliente se actualiza solo — sin actualizaciones manuales después de la primera descarga.",
  },

  features: {
    eyebrow: "/ Funciones del cliente",
    title: "Domina cada llamada de IA",
    sub: "Un cliente de escritorio nativo con panel integrado — uso, cuotas y estado de la toma de control siempre a la vista.",
    shotAlt: "Consola del cliente BingchaAI mostrando estadísticas de solicitudes, barras de cuota por modelo y estado de la toma de control",
    shotCaption: "Consola del cliente — estadísticas de solicitudes, uso por modelo y estado de la toma de control en vivo",
    dashTitle: "Panel en vivo",
    dash: [
      { t: "Solicitudes de hoy", d: "Total de solicitudes a modelos de IA en tiempo real, hasta la última llamada." },
      { t: "Registro de errores", d: "Las solicitudes fallidas quedan registradas para que detectes problemas rápido." },
      { t: "Tokens de entrada / salida", d: "Conteo de tokens enviados y recibidos, por separado." },
      {
        t: "Dinero ahorrado",
        d: "Calculado en vivo según los modelos reales y los precios oficiales de suscripción — un número verde destacado muestra el valor de un vistazo.",
      },
    ],
    quotaTitle: "Barras de cuota por modelo",
    quotaIntroPre: "El cliente incluye ",
    quotaIntroStrong: "barras de cuota en vivo",
    quotaIntroPost: " para la cuota de cada modelo. Cada producto usa ventanas de cuota distintas:",
    models: [
      {
        name: "Claude (Anthropic)",
        win: "Ventanas de 5 horas + semanal",
        desc: "Ambas ventanas se siguen por separado, las barras se actualizan en vivo, con cuenta regresiva del reinicio de cuota.",
      },
      {
        name: "Codex (OpenAI)",
        win: "Ventanas de 5 horas + semanal",
        desc: "Seguimiento de doble ventana que refleja con precisión las cuotas de ChatGPT Plus / Pro.",
      },
      {
        name: "Gemini (Google)",
        win: "Pool de cuota único",
        desc: "Uso de Gemini dentro de Antigravity IDE, mostrado como usado / total.",
      },
    ],
    resetNoteTitle: "Cuenta regresiva del reinicio de cuota",
    resetNote: "Cuando la cuota va quedando baja, la barra muestra cuánto falta para que se recupere — organiza tu trabajo con eso en mente.",
    takeoverTitle: "Panel de toma de control",
    takeoverIntroPre: "Cada producto tiene su propio interruptor — ",
    takeoverIntroStrong: "toma el control solo de las herramientas que quieras",
    takeoverIntroPost: "; el resto se queda nativo e intacto.",
    takeover: [
      { name: "Antigravity IDE", s: "Gemini + Claude, ambos modelos" },
      { name: "Antigravity Hub", s: "Todas las funciones de IA cubiertas" },
      { name: "OpenAI Codex", s: "Cuota Plus / Pro, directa" },
      { name: "Claude Code", s: "CLI + extensión de VS Code" },
      { name: "Claude Desktop", s: "macOS / Windows" },
    ],
    moreTitle: "Más destacados",
    more: [
      { t: "Actualizaciones automáticas", d: "OTA integrado: las nuevas versiones se descargan e instalan solas." },
      { t: "Anuncios", d: "Avisos operativos y alertas de mantenimiento, entregados en vivo." },
      { t: "Registro de solicitudes", d: "Cada solicitud queda registrada con hora, modelo y código de estado." },
      { t: "Detección de rutas", d: "Las rutas de instalación de IDE / Hub / Codex se detectan automáticamente, o se configuran a mano." },
      { t: "Todas las plataformas", d: "Windows · macOS (Intel + Apple Silicon) · Linux." },],
    settingsTitle: "Configuración",
    settings: [
      ["Ruta del IDE", "Directorio de instalación de Antigravity IDE — detectado automáticamente o elegido a mano."],
      ["Ruta del Hub", "Directorio de instalación de Antigravity Hub, también con detección automática."],
      ["Ruta de Codex", "Ruta de instalación de Codex CLI."],],
    ctaTitle: "¿Quieres probarlo tú mismo?",
    ctaSub: "Descarga el cliente de BingchaAI y mira estas funciones en acción.",
  },

  how: {
    eyebrow: "/ Cómo funciona",
    title: "Tokens inyectados en local, conexión oficial directa",
    sub: "Qué hace exactamente BingchaAI entre tu equipo y las API oficiales.",
    archTitle: "Arquitectura en resumen",
    archP1Pre: "BingchaAI ejecuta un ",
    archP1Strong1: "proxy local ligero",
    archP1Mid: " en tu equipo. No es un relay en la nube — tu código y tus conversaciones con la IA ",
    archP1Strong2: "nunca pasan por nuestros servidores",
    archP1Post: "; van directo a los endpoints oficiales de las API de Google, OpenAI y Anthropic.",
    coreNoteTitle: "Principio central",
    coreNote:
      "BingchaAI hace una sola cosa: inyectar el token de suscripción oficial correcto en tus solicitudes. No reescribe solicitudes, no cachea respuestas, no registra código — una capa pura de inyección de tokens.",
    lifecycleTitle: "Ciclo de vida de una solicitud",
    flow: [
      {
        t: "Interceptar la solicitud",
        d: "Un proxy local (127.0.0.1) intercepta de forma transparente las solicitudes del IDE hacia los servidores oficiales. Claude Code vía variables de entorno, Codex cambiando el provider, Claude Desktop vía un proxy MITM local.",
      },
      {
        t: "Alquilar una cuenta bajo demanda",
        d: "El motor de alquiler toma en tiempo real un token de cuenta oficial real (con cuota y vigencia) del pool — la deduplicación de concurrencia y la caché de tokens mantienen la latencia casi en cero.",
      },
      {
        t: "Intercambiar y conectar directo",
        d: "El proxy reemplaza el token provisional por el real y envía la solicitud directo a api.anthropic.com / chatgpt.com — opcionalmente vía una salida residencial fija.",
      },
      {
        t: "Transmitir de vuelta",
        d: "La respuesta oficial regresa al IDE sin cambios, contando el uso de tokens al vuelo. La experiencia es idéntica a una suscripción nativa.",
      },
    ],
    poolTitle: "Rotación del pool",
    poolIntro:
      "Bingcha mantiene un pool de cuentas de suscripción oficiales reales. Tu cliente alquila una cuenta disponible de forma dinámica:",
    pool: [
      { t: "Renovación automática", d: "Los tokens se renuevan solos mientras son válidos y el relevo es fluido antes de expirar." },
      { t: "Cambio al agotarse la cuota", d: "Cuando la cuenta actual se queda sin cuota, se cambia a otra cuenta con saldo disponible." },
      {
        t: "Aislamiento de riesgos",
        d: "Una cuenta marcada por la plataforma se declara inutilizable y sale del pool de inmediato — el resto de usuarios no se ve afectado.",
      },
      { t: "Reposición automática", d: "Se agregan cuentas nuevas al pool continuamente para mantener una oferta saludable." },
    ],
    productsTitle: "Toma de control por producto",
    products: [
      {
        name: "Antigravity (IDE · Hub)",
        items: [
          "Toma de control automática de ambos modelos: Gemini y Claude",
          "Experiencia en IDE / Hub idéntica a una suscripción nativa",
          "Al salir de la toma de control se restaura el estado original automáticamente",
        ],
      },
      {
        name: "OpenAI Codex CLI",
        items: [
          "El comando codex simplemente funciona — sin obtener tokens a mano",
          "La cuota de ChatGPT Plus / Pro se obtiene automáticamente",
          "Idéntico a la experiencia de la CLI oficial",
        ],
      },
      {
        name: "Claude Code · Desktop",
        items: [
          "CLI, extensión de VS Code y apps de escritorio para macOS/Windows",
          "No se toca ningún archivo de configuración de Claude — se restaura con un clic",
          "Acceso directo a la cuota de la suscripción Max / Pro",
        ],
      },
    ],
    safetyTitle: "Modelo de seguridad",
    safetyHeadline: "Nuestras promesas de seguridad",
    safetyLead: "El código va directo a los servidores oficiales; el proxy local solo inyecta tokens.",
    safe: [
      ["Sin envío de API Key", "Cuota de suscripción oficial — no es relay de API."],
      ["Sin cambios en la config del IDE", "La configuración original se restaura automáticamente al salir."],
      ["Sin recolección de código", "El proxy local solo inyecta tokens; el código va directo a los servidores oficiales."],
      ["Sin intermediarios", "Los datos de las solicitudes nunca pasan por los servidores de Bingcha."],
    ],
  },

  quickstart: {
    eyebrow: "/ Inicio rápido",
    title: "Tres pasos, 30 segundos",
    sub: "Descarga el cliente, ingresa tu tarjeta de acceso y toma el control con un clic. Sin API Key, sin cambiar de herramienta.",
    steps: [
      {
        t: "Descarga el cliente",
        d: "Consigue la versión para tu sistema en la página de descargas. Windows no necesita instalador, macOS se arrastra a Aplicaciones, Linux se extrae y ejecuta.",
      },
      {
        t: "Ingresa tu tarjeta de acceso",
        d: "Inicia el cliente, ingresa tu tarjeta de acceso de recarga (formato AI…) en “Tarjeta de cuenta” y haz clic en “Verificar y activar”. Las tarjetas se venden en bcai.store.",
      },
      {
        t: "Toma el control con un clic",
        d: "Elige los productos a controlar (IDE / Hub / Codex / Claude Code) en el panel de Toma de control y activa el interruptor — las solicitudes del IDE pasan automáticamente por el proxy local.",
      },
    ],
    goDownload: "Ir a descargas →",
    cardTitle: "Sobre las tarjetas de acceso",
    cardWhatTitle: "¿Qué es una tarjeta de acceso?",
    cardWhat:
      "Tu tarjeta de acceso es tu credencial de BingchaAI, con formato AI…. Cada tarjeta tiene una vigencia fija y una cobertura de productos; compra una nueva para renovar cuando expire.",
    cardBuyLabel: "Dónde comprar",
    cardBuyPre: "Las tarjetas están disponibles en ",
    cardBuyPost: ".",
    cardExpiryLabel: "Ver vencimiento",
    cardExpiry: "Tras la activación, la fecha de vencimiento se muestra en el cliente.",
    cardRenewLabel: "Renovación",
    cardRenew: "Ingresa una tarjeta nueva en cualquier momento antes del vencimiento — el relevo es fluido.",
    cardPlanLabel: "Planes",
    cardPlan: "Cada plan cubre distintas combinaciones de productos (Antigravity / Codex / Claude).",
    takeoverTitle: "Panel de toma de control",
    takeoverIntro: "BingchaAI toma el control de 5 productos de forma independiente, cada uno con su propio interruptor:",
    takeover: [
      ["Antigravity IDE", "Toma de control automática de Gemini y Claude — experiencia nativa"],
      ["Antigravity Hub", "Todas las funciones de IA del Hub cubiertas, sin afectar nada más"],
      ["OpenAI Codex", "El comando codex simplemente funciona, con cuota Plus / Pro"],
      ["Claude Code", "CLI y extensión de VS Code, conectados a suscripciones Max / Pro"],
      ["Claude Desktop", "Toma de control transparente en macOS y Windows"],
    ],
    ctaTitle: "¿Aún sin tarjeta de acceso?",
    ctaSub: "Consigue una en la tienda Bingcha — hay varios planes disponibles.",
  },

  faqPage: {
    eyebrow: "/ Preguntas frecuentes",
    title: "Preguntas frecuentes",
    sub: "¿Tienes un problema? Encuentra respuestas aquí o agrega a nuestro soporte en WeChat.",
    contactTitle: "Soporte",
    contactDesc: "¿Necesitas ayuda humana? Agrega a nuestro soporte en WeChat.",
    copy: "Copiar",
    copied: "Copiado",
    qrAlt: "Código QR de WeChat de soporte",
    scanToAdd: "Escanea para agregar",
    searchPlaceholder: "Buscar preguntas…",
    searchAria: "Buscar en preguntas frecuentes",
    noMatch: "No hay preguntas que coincidan.",
    empty: "Aún no hay preguntas frecuentes.",
    questionCount: "{n} preguntas",
  },









  statusLabels: {
    HEALTHY: "Normal",
    LOGIN_REQUIRED: "Requiere inicio de sesión",
    VERIFICATION_REQUIRED: "Requiere verificación",
    DISABLED: "Deshabilitado",
    ACTIVE: "Activo",
    MANUAL_ONLY: "Solo manual",
    PENDING: "Pendiente",
    RUNNING: "En ejecución",
    TASK_QUEUED: "En proceso",
    TASK_RUNNING: "Tarea en ejecución",
    CODE_VERIFIED: "Código verificado",
    GROUP_ASSIGNED: "Grupo asignado",
    INVITE_SENT: "Invitación enviada",
    WAIT_USER_ACCEPT: "Esperando aceptación",
    COMPLETED: "Completado",
    FAILED: "Fallido",
    EXPIRED: "Vencido",
    CANCELLED: "Cancelado",
    MANUAL_REVIEW: "Revisión manual",
    REPLACED_AND_INVITE_SENT: "Cambiado e invitado",
    FAILED_FINAL: "Fallo definitivo",
    FAILED_RETRYABLE: "Reintentable",
    INVITE_MEMBER: "Invitar miembro",
    REMOVE_MEMBER: "Eliminar miembro",
    REPLACE_MEMBER: "Reemplazar miembro",
    SYNC_FAMILY_GROUP: "Sincronizar grupo familiar",
    HEALTH_CHECK_ACCOUNT: "Comprobación de estado",
    UNUSED: "Sin usar",
    USED: "Usado",
    RESERVED: "Reservado",
    ACCEPTED: "Aceptado",
    REMOVED: "Eliminado",
    SENT: "Enviado",
    CREATED: "Creado",
    SUSPENDED: "Suspendido",
    SUCCESS: "Éxito",
    RISKY: "En riesgo",
    ADMIN: "Admin",
    OPERATIONS: "Operaciones",
    SUPPORT: "Soporte",
    OWNER: "Cuenta principal",
    MEMBER: "Miembro",
    TOTP: "Configurado",
    "No TOTP": "Sin configurar",
    GOOGLE_ONE: "Google One",
    REMOVING: "Eliminando",
    INVITING: "Invitando",
    PARTIALLY_FAILED: "Fallo parcial",
    NOT_STARTED: "Sin iniciar",
  },
};
