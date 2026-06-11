import type { DeepPartialDict } from "./types";

/** vi — Tiếng Việt;缺失键运行时回退简体中文。 */
export const vi: DeepPartialDict = {
  meta: {
    title: "BingchaAI — Tiếp thêm chỉ một cú nhấp cho công cụ lập trình AI",
    description:
      "BingchaAI là ứng dụng desktop tiếp quản Antigravity IDE, OpenAI Codex, Claude Code và các công cụ lập trình AI khác bằng tài khoản đăng ký chính thức thật. Không cần API Key, không giảm tốc, không đội giá.",
    faqTitle: "Câu hỏi thường gặp — BingchaAI",
    faqDescription:
      "Giải đáp các câu hỏi thường gặp về BingchaAI: lời mời vào nhóm gia đình, tiếp quản ứng dụng, thẻ truy cập và hạn mức.",
    featuresTitle: "Tính năng ứng dụng — BingchaAI",
    featuresDescription:
      "Ứng dụng desktop BingchaAI: bảng điều khiển thời gian thực, thanh hạn mức theo mô hình, điều khiển tiếp quản, theo dõi tiền tiết kiệm, hỗ trợ mọi nền tảng.",
    howTitle: "Cách hoạt động — BingchaAI",
    howDescription:
      "BingchaAI làm gì giữa máy của bạn và API chính thức: proxy cục bộ chèn token, kết nối thẳng máy chủ chính thức, không làm trung gian.",
    quickstartTitle: "Bắt đầu nhanh — BingchaAI",
    quickstartDescription:
      "Dùng BingchaAI trong ba bước: tải ứng dụng, nhập thẻ truy cập, tiếp quản bằng một cú nhấp. Chưa đến 30 giây là dùng được.",
    downloadTitle: "Tải ứng dụng — BingchaAI",
    downloadDescription:
      "Tải ứng dụng desktop BingchaAI cho Windows, macOS và Linux. Tiếp thêm chỉ một cú nhấp — nhập thẻ truy cập là dùng được.",
  },

  common: {
    downloadClient: "Tải ứng dụng",
    buyCard: "Mua thẻ truy cập ↗",
    brandName: "BingchaAI",
  },

  nav: {
    features: "Tính năng",
    howItWorks: "Cách hoạt động",
    quickstart: "Bắt đầu nhanh",
    faq: "Câu hỏi thường gặp",
    menu: "Menu",
    mainNav: "Điều hướng chính",
    toggleTheme: "Chuyển giao diện sáng / tối",
  },

  footer: {
    desc: "Công cụ tiếp quản tài khoản chính thức cho các công cụ lập trình AI phổ biến. Kết nối thẳng máy chủ chính thức — không làm trung gian.",
    product: "Sản phẩm",
    download: "Tải ứng dụng",
    features: "Tính năng",
    quickstart: "Bắt đầu nhanh",
    howItWorks: "Cách hoạt động",
    help: "Trợ giúp",
    faq: "Câu hỏi thường gặp",
    store: "Cửa hàng Bingcha ↗",
    api: "Bingcha API ↗",
    terminal: "Bingcha Terminal ↗",
    copyright: "© 2026 BingchaAI",
    tagline: "Kết nối thẳng chính thức · Không trung gian · Mã nguồn không đi qua chúng tôi",
  },

  mock: {
    proxyStatus: "Proxy",
    running: "Đang chạy",
    todayRequests: "Yêu cầu hôm nay",
    errors: "Lỗi",
    inputTokens: "Token đầu vào",
    outputTokens: "Token đầu ra",
    takeoverStatus: "Tiếp quản",
    takenOver: "Đã tiếp quản",
    notTakenOver: "Chưa tiếp quản",
    modelQuota: "Hạn mức mô hình",
  },

  home: {
    eyebrow: "/ Tiếp quản tài khoản chính thức, tiếp thêm một cú nhấp",
    h1Line1: "Để công cụ lập trình AI",
    h1Line2Prefix: "kết nối thẳng ",
    h1Line2Accent: "tài khoản chính thức",
    sub: "BingchaAI cấp cho bạn tài khoản đăng ký chính thức thật, để Antigravity, Claude Code và Codex CLI vẫn kết nối thẳng máy chủ chính thức như thường lệ — không cấu hình API Key, không đổi công cụ, không phải tự đối phó kiểm soát rủi ro.",
    trust1: "Kết nối thẳng chính thức",
    trust2: "Không trung gian",
    trust3: "Mã nguồn không đi qua chúng tôi",
    ecosystemsTitle: "Một ứng dụng, ba hệ sinh thái",
    ecosystemsLead:
      "Các công cụ lập trình AI phổ biến dùng được ngay. Sau khi tiếp quản, bạn dùng như bình thường — yêu cầu mô hình tự động đi qua kho tài khoản Bingcha.",
    ecosystems: [
      {
        name: "Antigravity",
        tag: "IDE · Hub",
        desc: "IDE lập trình AI của Google. Sau khi tiếp quản, yêu cầu Gemini / Claude tự động đi qua kho tài khoản Bingcha — trình soạn thảo không hề hay biết.",
      },
      {
        name: "OpenAI Codex",
        tag: "CLI",
        desc: "Agent lập trình AI của OpenAI. Tự động nhận token ChatGPT Plus / Pro — lệnh codex dùng được ngay, không đụng tới API Key.",
      },
      {
        name: "Claude Code",
        tag: "CLI · VSCode · Desktop",
        desc: "Claude Code CLI, tiện ích mở rộng VS Code và bản desktop macOS, kết nối thẳng gói Max / Pro. Hết hạn mức? Tự động tiếp thêm.",
      },
    ],
    logoAlt: "Logo {name}",
    howTitle: "Chèn token tại máy bạn, kết nối thẳng chính thức",
    howLead:
      "Token chính thức thật được chèn vào công cụ ngay trên máy bạn, mã nguồn gửi thẳng tới điểm cuối chính thức. Bingcha chỉ thay token ở lớp proxy cục bộ — không bao giờ làm trung gian.",
    how: [
      {
        t: "Khởi chạy proxy cục bộ",
        d: "Một proxy gọn nhẹ chạy trên máy bạn và tiếp quản từng công cụ theo cách chuẩn — không động vào mã nguồn, khôi phục được bằng một cú nhấp.",
      },
      {
        t: "Thuê tài khoản chính thức theo nhu cầu",
        d: "Ngay khi công cụ gửi yêu cầu, một token chính thức thật được thuê từ kho tài khoản theo thời gian thực, gần như không thêm độ trễ.",
      },
      {
        t: "Thay token, đi thẳng chính thức",
        d: "Token giữ chỗ được thay bằng token thật và yêu cầu gửi thẳng tới điểm cuối chính thức — mã nguồn không đi qua Bingcha.",
      },
      {
        t: "Thống kê thời gian thực, tự động đổi tài khoản",
        d: "Lượng dùng được tính ngay khi phản hồi truyền về; khi hết hạn mức hoặc gặp kiểm soát rủi ro, hệ thống tự chuyển sang tài khoản dự phòng.",
      },
    ],
    quickstartLabel: "Bắt đầu nhanh",
    quickstartSteps: ["Tải ứng dụng", "Nhập thẻ truy cập", "Nhấn Tiếp quản"],
    quickstartNote: "Chưa đến 30 giây — viết code như thường",
    capsTitle: "Mọi phức tạp của kho tài khoản, để chúng tôi lo",
    capsLead:
      "Một tài khoản đơn lẻ sẽ cạn hạn mức, bị đánh dấu rủi ro, bị chiếm hết chỗ. Điều phối thông minh, đầu ra cố định và cách ly rủi ro để bạn chỉ việc viết code.",
    caps: [
      {
        t: "Điều phối kho tài khoản thông minh",
        d: "Không phải phát ngẫu nhiên. Tài khoản được chấm điểm tổng hợp theo độ gắn kết, mức tải, hạng gói và hạn mức còn lại của từng mô hình — mỗi lần đều chọn tài khoản tốt nhất tại thời điểm đó.",
      },
      {
        t: "Hạn mức dùng chung / dùng riêng — tùy bạn chọn",
        d: "Thẻ kho chung chia sẻ tài khoản giữa nhiều người, giá tốt hơn; thẻ gắn riêng có tài khoản dành riêng, hạn mức ổn định hơn. Khi nhiều người dùng chung một tài khoản, thuật toán giới hạn công bằng bảo đảm mỗi người nhận đúng phần của mình, không ai chiếm hết.",
      },
      {
        t: "Đầu ra cố định, cách ly rủi ro",
        d: "Tùy chọn IP đầu ra cố định dạng dân cư giúp kết nối ổn định, khó kích hoạt kiểm soát rủi ro vì IP; một tài khoản gặp sự cố thì chỉ tài khoản đó bị cách ly, hệ thống tự đổi và bổ sung tài khoản, không ảnh hưởng người dùng khác.",
      },
      {
        t: "Thanh hạn mức thời gian thực",
        d: "Token được đếm ngay khi phản hồi truyền về, phản chiếu cửa sổ trượt 5 giờ của máy chủ ngay trên máy bạn. Mỗi mô hình hiển thị hạn mức còn lại theo thời điểm đặt lại thật — lượng dùng và tiền đã tiết kiệm thấy ngay.",
      },
      {
        t: "Tiếp quản một cú nhấp, không cần cấu hình",
        d: "Mở ứng dụng → nhập thẻ truy cập → nhấn Tiếp quản. Không API Key, không đổi công cụ, không phải học gì mới — và một cú nhấp khôi phục tất cả.",
      },
    ],
    compareTitle: "Vì sao chọn BingchaAI",
    compareLead: "So với tự đăng ký hoặc dùng trung chuyển API, Bingcha thắng về độ phủ, độ ổn định và sự an tâm.",
    compareColUs: "BingchaAI",
    compareColOwn: "Tự đăng ký",
    compareColRelay: "Trung chuyển API",
    compareRows: [
      ["Dùng tài khoản đăng ký chính thức", "Có", "Có", "Không (API Key)"],
      ["Tốc độ nguyên bản", "Có", "Có", "Có thể bị giảm tốc"],
      ["Phủ nhiều sản phẩm", "3 hệ sinh thái", "Phải đăng ký từng cái", "Tùy bên trung chuyển"],
      ["Tự đổi tài khoản / dự phòng khi khóa", "Tự động", "Tự lo", "Tự lo"],
      ["Độ phức tạp khi cấu hình", "Không cần cấu hình", "Thủ công", "Điền Key + sửa cấu hình"],
      ["Theo dõi lượng dùng", "Bảng điều khiển", "Không có", "Tùy bên trung chuyển"],
    ],
    trustTitle: "Mã nguồn của bạn không đi qua chúng tôi",
    trustLead: "Ứng dụng BingchaAI chạy trên chính máy của bạn và chỉ làm đúng một việc: chèn token ủy quyền vào công cụ của bạn.",
    trustPoints: [
      { b: "Không gửi API Key", s: "Ứng dụng chỉ chèn token ủy quyền — không để lộ bất kỳ khóa bí mật nào cho bên thứ ba." },
      { b: "Không sửa cấu hình IDE", s: "Trình soạn thảo, plugin và quy trình làm việc của bạn giữ nguyên, có thể tắt bằng một cú nhấp bất cứ lúc nào." },
      { b: "Không thu thập mã nguồn", s: "Dữ liệu mã nguồn gửi thẳng tới máy chủ chính thức — Bingcha không làm proxy trung gian, không lưu trữ gì." },
    ],
    ctaTitle: "Sẵn sàng tiếp thêm chưa?",
    ctaSub: "Tải ứng dụng BingchaAI, hoặc mua trước một thẻ truy cập tại cửa hàng — 30 giây sau là viết code như thường.",
  },

  download: {
    eyebrow: "/ Tải xuống",
    title: "Tải ứng dụng BingchaAI",
    sub: "Tiếp thêm chỉ một cú nhấp, không cần plugin IDE. Tải về chạy ngay, nhập thẻ truy cập là dùng được.",
    recommended: "Khuyên dùng",
    winMeta: "Windows 10 / 11 (64-bit) · v{version} · {size} MB",
    winHint: "Không cần cài đặt — tải về nhấp đúp là chạy.",
    downloadNow: "Tải ngay",
    macMeta: "macOS 12+ · v{version}",
    macHint: "Lần mở đầu tiên: nhấp chuột phải vào ứng dụng → Mở → xác nhận mở.",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    linuxMeta: "x86_64 · v{version}",
    downloadTar: "Tải tar.gz",
    linuxHint: "Giải nén, chmod +x rồi chạy.",
    changelogTitle: "Có gì mới trong v{version}",
    guideTitle: "Hướng dẫn sử dụng",
    steps: [
      "Tải BingchaAI về là chạy được ngay (Windows không cần cài đặt; macOS kéo vào thư mục Applications).",
      "Nhập thẻ truy cập tiếp thêm của bạn, hoặc chuyển sang chế độ kho cục bộ để thêm tài khoản riêng.",
      "Nhấn “Tiếp quản” rồi tiếp tục dùng Antigravity / Claude Code / Codex như bình thường.",
    ],
    autoUpdateNote: "Ứng dụng tự động cập nhật — sau lần tải đầu tiên không cần nâng cấp thủ công.",
  },

  features: {
    eyebrow: "/ Tính năng ứng dụng",
    title: "Làm chủ mọi lần gọi AI",
    sub: "Ứng dụng desktop nguyên bản với bảng điều khiển tích hợp — lượng dùng, hạn mức và trạng thái tiếp quản luôn trong tầm mắt.",
    shotAlt: "Bảng điều khiển BingchaAI hiển thị thống kê yêu cầu, thanh hạn mức mô hình và trạng thái tiếp quản",
    shotCaption: "Bảng điều khiển ứng dụng — thống kê yêu cầu, lượng dùng mô hình và trạng thái tiếp quản theo thời gian thực",
    dashTitle: "Bảng điều khiển thời gian thực",
    dash: [
      { t: "Yêu cầu hôm nay", d: "Thống kê tổng số yêu cầu mô hình AI theo thời gian thực, chính xác tới từng lần gọi." },
      { t: "Theo dõi lỗi", d: "Ghi lại số lần yêu cầu thất bại, giúp bạn phát hiện vấn đề nhanh chóng." },
      { t: "Token đầu vào / đầu ra", d: "Đếm riêng số token gửi đi và nhận về." },
      {
        t: "Tiền đã tiết kiệm",
        d: "Tính theo mô hình thực dùng và giá đăng ký chính thức theo thời gian thực — con số xanh nổi bật cho thấy giá trị ngay.",
      },
    ],
    quotaTitle: "Thanh hạn mức mô hình",
    quotaIntroPre: "Ứng dụng tích hợp sẵn ",
    quotaIntroStrong: "thanh hạn mức thời gian thực",
    quotaIntroPost: " hiển thị mức tiêu hao hạn mức của từng mô hình. Mỗi sản phẩm dùng cửa sổ hạn mức khác nhau:",
    models: [
      {
        name: "Claude (Anthropic)",
        win: "Cửa sổ 5 giờ + cửa sổ tuần",
        desc: "Hai cửa sổ tính độc lập, thanh cập nhật theo thời gian thực, kèm đếm ngược đặt lại hạn mức.",
      },
      {
        name: "Codex (OpenAI)",
        win: "Cửa sổ 5 giờ + cửa sổ tuần",
        desc: "Cơ chế hai cửa sổ, bám sát chính xác hạn mức ChatGPT Plus / Pro.",
      },
      {
        name: "Gemini (Google)",
        win: "Một kho hạn mức duy nhất",
        desc: "Lượng dùng Gemini trong Antigravity IDE, hiển thị đã dùng / tổng.",
      },
    ],
    resetNoteTitle: "Đếm ngược đặt lại hạn mức",
    resetNote: "Khi hạn mức sắp cạn, thanh sẽ hiển thị bao lâu nữa hồi phục — giúp bạn sắp xếp nhịp làm việc.",
    takeoverTitle: "Bảng điều khiển tiếp quản",
    takeoverIntroPre: "Mỗi sản phẩm có công tắc riêng — ",
    takeoverIntroStrong: "chỉ tiếp quản đúng những công cụ bạn cần",
    takeoverIntroPost: "; phần còn lại giữ nguyên trạng thái gốc, không bị ảnh hưởng.",
    takeover: [
      { name: "Antigravity IDE", s: "Gemini + Claude, cả hai mô hình" },
      { name: "Antigravity Hub", s: "Phủ toàn bộ tính năng AI" },
      { name: "OpenAI Codex", s: "Dùng thẳng hạn mức Plus / Pro" },
      { name: "Claude Code", s: "CLI + tiện ích mở rộng VS Code" },
      { name: "Claude Desktop", s: "macOS / Windows" },
    ],
    moreTitle: "Điểm nổi bật khác",
    more: [
      { t: "Tự động cập nhật", d: "OTA tích hợp sẵn: phiên bản mới tự tải về và cài đặt." },
      { t: "Hệ thống thông báo", d: "Nhận thông báo vận hành và bảo trì theo thời gian thực." },
      { t: "Nhật ký yêu cầu", d: "Ghi đầy đủ thời gian, mô hình, mã trạng thái của mỗi yêu cầu." },
      { t: "Dò đường dẫn", d: "Tự động dò đường dẫn cài đặt IDE / Hub / Codex, cũng hỗ trợ chỉ định thủ công." },
      { t: "Mọi nền tảng", d: "Windows · macOS (Intel + Apple Silicon) · Linux." },],
    settingsTitle: "Trang cài đặt",
    settings: [
      ["Đường dẫn IDE", "Thư mục cài đặt Antigravity IDE — tự động dò hoặc duyệt thủ công."],
      ["Đường dẫn Hub", "Thư mục cài đặt Antigravity Hub, cũng hỗ trợ tự động dò."],
      ["Đường dẫn Codex", "Cấu hình đường dẫn cài đặt Codex CLI."],],
    ctaTitle: "Muốn tự mình trải nghiệm?",
    ctaSub: "Tải ứng dụng BingchaAI và cảm nhận những tính năng này.",
  },

  how: {
    eyebrow: "/ Cách hoạt động",
    title: "Chèn token tại máy bạn, kết nối thẳng chính thức",
    sub: "BingchaAI thực sự làm gì giữa máy của bạn và API chính thức.",
    archTitle: "Tổng quan kiến trúc",
    archP1Pre: "BingchaAI chạy một ",
    archP1Strong1: "proxy cục bộ gọn nhẹ",
    archP1Mid: " trên máy bạn. Đây không phải trung chuyển đám mây — mã nguồn và hội thoại AI của bạn ",
    archP1Strong2: "không bao giờ đi qua máy chủ của chúng tôi",
    archP1Post: ", mà gửi thẳng tới điểm cuối API chính thức của Google, OpenAI và Anthropic.",
    coreNoteTitle: "Nguyên tắc cốt lõi",
    coreNote:
      "BingchaAI chỉ làm một việc: chèn đúng token đăng ký chính thức vào yêu cầu của bạn. Không sửa nội dung yêu cầu, không cache phản hồi, không ghi lại mã nguồn — một lớp chèn token thuần túy.",
    lifecycleTitle: "Vòng đời một yêu cầu",
    flow: [
      {
        t: "Chặn yêu cầu",
        d: "Proxy cục bộ (127.0.0.1) chặn trong suốt các yêu cầu IDE gửi tới máy chủ chính thức. Claude Code qua biến môi trường, Codex qua chuyển provider, Claude bản desktop qua MITM cục bộ.",
      },
      {
        t: "Thuê tài khoản theo nhu cầu",
        d: "Bộ máy thuê lấy một token tài khoản chính thức thật (kèm hạn mức và hạn dùng) từ kho theo thời gian thực — khử trùng lặp song song + cache token giúp gần như không thêm độ trễ.",
      },
      {
        t: "Thay token, đi thẳng",
        d: "Proxy thay token giữ chỗ bằng token thật và gửi yêu cầu thẳng tới điểm cuối chính thức api.anthropic.com / chatgpt.com — tùy chọn đi qua đầu ra dân cư cố định.",
      },
      {
        t: "Truyền phản hồi về",
        d: "Phản hồi chính thức truyền nguyên vẹn về IDE, vừa chuyển tiếp vừa đếm lượng token; trải nghiệm y hệt gói đăng ký gốc.",
      },
    ],
    poolTitle: "Cơ chế xoay vòng kho tài khoản",
    poolIntro:
      "Bingcha duy trì một kho tài khoản đăng ký chính thức thật; ứng dụng của bạn “thuê” linh hoạt một tài khoản khả dụng:",
    pool: [
      { t: "Tự động gia hạn thuê", d: "Token tự gia hạn trong thời gian hiệu lực, chuyển êm sang token mới trước khi hết hạn." },
      { t: "Đổi khi cạn hạn mức", d: "Tài khoản hiện tại hết hạn mức, hệ thống tự chuyển sang tài khoản khác trong kho còn dư." },
      {
        t: "Cách ly rủi ro",
        d: "Tài khoản bị nền tảng đánh dấu rủi ro sẽ lập tức bị đánh dấu không khả dụng và rút khỏi kho — không ảnh hưởng người dùng khác.",
      },
      { t: "Tự động bổ sung", d: "Hệ thống liên tục bổ sung tài khoản mới vào kho, bảo đảm luôn đủ tài khoản khả dụng." },
    ],
    productsTitle: "Trải nghiệm tiếp quản từng sản phẩm",
    products: [
      {
        name: "Antigravity (IDE · Hub)",
        items: [
          "Tự động tiếp quản cả hai mô hình Gemini và Claude",
          "Trải nghiệm trong IDE / Hub y hệt gói đăng ký gốc",
          "Thoát tiếp quản tự khôi phục trạng thái ban đầu",
        ],
      },
      {
        name: "OpenAI Codex CLI",
        items: [
          "Lệnh codex dùng được ngay — không cần tự lấy token",
          "Tự động nhận hạn mức ChatGPT Plus / Pro",
          "Trải nghiệm y hệt CLI chính thức",
        ],
      },
      {
        name: "Claude Code · Desktop",
        items: [
          "CLI, tiện ích mở rộng VS Code và bản desktop macOS/Windows",
          "Không sửa bất kỳ tệp cấu hình nào của Claude — khôi phục bằng một cú nhấp",
          "Dùng thẳng hạn mức gói Max / Pro",
        ],
      },
    ],
    safetyTitle: "Mô hình bảo mật",
    safetyHeadline: "Cam kết bảo mật của chúng tôi",
    safetyLead: "Mã nguồn đi thẳng tới máy chủ chính thức; proxy cục bộ chỉ chèn token.",
    safe: [
      ["Không gửi API Key", "Dùng hạn mức đăng ký chính thức — không phải trung chuyển API."],
      ["Không sửa cấu hình IDE", "Cấu hình gốc tự khôi phục khi thoát tiếp quản."],
      ["Không thu thập mã nguồn", "Proxy cục bộ chỉ chèn token; mã nguồn đi thẳng tới chính thức."],
      ["Không làm trung gian", "Dữ liệu yêu cầu không đi qua máy chủ Bingcha."],
    ],
  },

  quickstart: {
    eyebrow: "/ Bắt đầu nhanh",
    title: "Ba bước, 30 giây là dùng được",
    sub: "Tải ứng dụng, nhập thẻ truy cập, tiếp quản bằng một cú nhấp — không cần API Key, không cần đổi công cụ.",
    steps: [
      {
        t: "Tải ứng dụng",
        d: "Vào trang tải xuống lấy bản phù hợp hệ điều hành của bạn. Windows không cần cài đặt, macOS kéo vào thư mục Applications, Linux giải nén rồi chạy.",
      },
      {
        t: "Nhập thẻ truy cập",
        d: "Mở ứng dụng, nhập thẻ truy cập tiếp thêm (định dạng AI…) tại mục “Cấu hình thẻ tài khoản”, rồi nhấn “Xác minh kích hoạt”. Thẻ bán tại bcai.store.",
      },
      {
        t: "Tiếp quản một cú nhấp",
        d: "Trong bảng “Tiếp quản”, chọn sản phẩm cần tiếp quản (IDE / Hub / Codex / Claude Code) rồi gạt công tắc — yêu cầu của IDE tự động đi qua proxy cục bộ.",
      },
    ],
    goDownload: "Đến trang tải xuống →",
    cardTitle: "Về thẻ truy cập",
    cardWhatTitle: "Thẻ truy cập là gì?",
    cardWhat:
      "Thẻ truy cập là chứng nhận sử dụng BingchaAI của bạn, định dạng AI…. Mỗi thẻ có thời hạn hiệu lực và phạm vi sản phẩm cố định; hết hạn thì mua thẻ mới để gia hạn.",
    cardBuyLabel: "Mua ở đâu",
    cardBuyPre: "Thẻ truy cập bán tại ",
    cardBuyPost: ".",
    cardExpiryLabel: "Xem hạn dùng",
    cardExpiry: "Sau khi kích hoạt, có thể xem thời điểm hết hạn trong ứng dụng.",
    cardRenewLabel: "Gia hạn",
    cardRenew: "Nhập thẻ mới bất cứ lúc nào trước khi hết hạn — chuyển tiếp liền mạch.",
    cardPlanLabel: "Gói",
    cardPlan: "Các gói khác nhau hỗ trợ tổ hợp sản phẩm khác nhau (Antigravity / Codex / Claude).",
    takeoverTitle: "Bảng tiếp quản",
    takeoverIntro: "BingchaAI hỗ trợ tiếp quản độc lập 5 sản phẩm, mỗi sản phẩm có công tắc riêng:",
    takeover: [
      ["Antigravity IDE", "Tự động tiếp quản cả Gemini và Claude, trải nghiệm như nguyên bản"],
      ["Antigravity Hub", "Phủ toàn bộ tính năng AI trong Hub, không ảnh hưởng chức năng khác"],
      ["OpenAI Codex", "Lệnh codex dùng được ngay, tự động nhận hạn mức Plus / Pro"],
      ["Claude Code", "Hỗ trợ cả CLI và tiện ích mở rộng VS Code, kết nối thẳng gói Max / Pro"],
      ["Claude Desktop", "Tiếp quản trong suốt trên cả macOS / Windows"],
    ],
    ctaTitle: "Chưa có thẻ truy cập?",
    ctaSub: "Đến cửa hàng Bingcha mua thẻ tiếp thêm — nhiều gói để chọn.",
  },

  faqPage: {
    eyebrow: "/ Câu hỏi thường gặp",
    title: "Câu hỏi thường gặp",
    sub: "Gặp vấn đề khi sử dụng? Tìm câu trả lời tại đây, hoặc thêm WeChat của bộ phận hỗ trợ.",
    contactTitle: "Hỗ trợ khách hàng",
    contactDesc: "Cần người hỗ trợ trực tiếp? Thêm WeChat của bộ phận hỗ trợ.",
    copy: "Sao chép",
    copied: "Đã sao chép",
    qrAlt: "Mã QR WeChat hỗ trợ",
    scanToAdd: "Quét mã để thêm",
    searchPlaceholder: "Tìm câu hỏi…",
    searchAria: "Tìm trong câu hỏi thường gặp",
    noMatch: "Không có câu hỏi phù hợp.",
    empty: "Chưa có câu hỏi thường gặp.",
    questionCount: "{n} câu hỏi",
  },









  statusLabels: {
    HEALTHY: "Bình thường",
    LOGIN_REQUIRED: "Cần đăng nhập",
    VERIFICATION_REQUIRED: "Cần xác minh",
    DISABLED: "Đã vô hiệu",
    ACTIVE: "Đang hoạt động",
    MANUAL_ONLY: "Chỉ thủ công",
    PENDING: "Chờ xử lý",
    RUNNING: "Đang thực thi",
    TASK_QUEUED: "Đang xử lý",
    TASK_RUNNING: "Tác vụ đang chạy",
    CODE_VERIFIED: "Mã đã xác minh",
    GROUP_ASSIGNED: "Đã gán nhóm",
    INVITE_SENT: "Đã gửi lời mời",
    WAIT_USER_ACCEPT: "Chờ chấp nhận",
    COMPLETED: "Đã hoàn tất",
    FAILED: "Thất bại",
    EXPIRED: "Đã hết hạn",
    CANCELLED: "Đã hủy",
    MANUAL_REVIEW: "Xử lý thủ công",
    REPLACED_AND_INVITE_SENT: "Đã đổi & gửi lời mời",
    FAILED_FINAL: "Thất bại (cuối cùng)",
    FAILED_RETRYABLE: "Có thể thử lại",
    INVITE_MEMBER: "Mời thành viên",
    REMOVE_MEMBER: "Gỡ thành viên",
    REPLACE_MEMBER: "Thay thành viên",
    SYNC_FAMILY_GROUP: "Đồng bộ nhóm gia đình",
    HEALTH_CHECK_ACCOUNT: "Kiểm tra tình trạng",
    UNUSED: "Chưa dùng",
    USED: "Đã dùng",
    RESERVED: "Đã giữ chỗ",
    ACCEPTED: "Đã chấp nhận",
    REMOVED: "Đã gỡ",
    SENT: "Đã gửi",
    CREATED: "Đã tạo",
    SUSPENDED: "Đã tạm dừng",
    SUCCESS: "Thành công",
    RISKY: "Rủi ro",
    ADMIN: "Quản trị viên",
    OPERATIONS: "Vận hành",
    SUPPORT: "Hỗ trợ",
    OWNER: "Tài khoản chủ",
    MEMBER: "Thành viên",
    TOTP: "Đã thiết lập",
    "No TOTP": "Chưa thiết lập",
    GOOGLE_ONE: "Google One",
    REMOVING: "Đang gỡ",
    INVITING: "Đang mời",
    PARTIALLY_FAILED: "Thất bại một phần",
    NOT_STARTED: "Chưa bắt đầu",
  },
};
