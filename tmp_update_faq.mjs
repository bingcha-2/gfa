/**
 * Direct database update for FAQ items using Prisma.
 * Bypasses API auth — runs against the database directly.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const FAQ_DATA = [
  // ═══ 一、账号与会员权益 ═══
  { category: '账号与会员权益', question: 'ULTRA 会员与普通账号有什么区别？', sortOrder: 100, answer: `<table style="width:100%;border-collapse:collapse;margin:8px 0"><tr><th style="text-align:left;border-bottom:1px solid #444;padding:6px">特性</th><th style="text-align:left;border-bottom:1px solid #444;padding:6px">普通账号</th><th style="text-align:left;border-bottom:1px solid #444;padding:6px">ULTRA 账号</th></tr><tr><td style="padding:6px">额度</td><td style="padding:6px">极低（几乎不可用）</td><td style="padding:6px">高额度</td></tr><tr><td style="padding:6px">模型</td><td style="padding:6px">部分模型受限</td><td style="padding:6px">Gemini Pro / Claude 全系可用</td></tr><tr><td style="padding:6px">价格</td><td style="padding:6px">免费但无实用价值</td><td style="padding:6px">付费但额度充足</td></tr><tr><td style="padding:6px">家庭组</td><td style="padding:6px">无需加入</td><td style="padding:6px">必须加入才能享受权益</td></tr></table>` },
  { category: '账号与会员权益', question: '为什么必须加入家庭组？', sortOrder: 101, answer: `<p>所有从冰茶购买的账号，登录后<strong>必须第一时间加入家庭组</strong>！</p><p>家庭组是 Google ULTRA 会员权益的载体。不加入家庭组则无法享受 ULTRA 额度，所购买的账号将只有极低的普通免费额度，几乎无法正常使用 Gemini、Claude 等模型服务。</p>` },
  { category: '账号与会员权益', question: '加入家庭组时提示地区/国家不一致怎么办？', sortOrder: 102, answer: `<p>先确认 VPN 节点为<strong>美国</strong>（非常重要，节点必须在美国）。</p><p>然后打开 <a href="https://payments.google.com" target="_blank">payments.google.com</a> 检查节点是否有问题：如果出现支付页面，说明节点 IP 不干净，建议切换节点、开启全局模式后多刷新几次重试。</p>` },
  { category: '账号与会员权益', question: '如何确认自己已成功加入家庭组？', sortOrder: 103, answer: `<p>登录账号后，打开 <a href="https://myaccount.google.com/u/2/family/details" target="_blank">myaccount.google.com/family/details</a>。</p><p>如果能看到家庭组信息（如成员列表、到期时间等），说明加入成功。也可以在 Gemini 或 Antigravity 中测试对话，如果有 ULTRA 额度显示则说明家庭组已生效。</p>` },
  { category: '账号与会员权益', question: '加入家庭组后多久生效？', sortOrder: 104, answer: `<p>通常接受邀请后 <strong>1-5 分钟</strong>内生效。如果 5 分钟后仍未看到 ULTRA 额度，请尝试：</p><ol><li>退出账号重新登录。</li><li>清除浏览器缓存后刷新 Gemini 页面。</li></ol>` },
  { category: '账号与会员权益', question: '一个家庭组最多可以加入多少人？', sortOrder: 105, answer: `<p>Google 家庭组最多支持 <strong>6 名成员</strong>（含组长）。如提示家庭组已满，请联系客服协调。</p>` },
  { category: '账号与会员权益', question: '可以同时加入多个家庭组吗？', sortOrder: 106, answer: `<p><strong>不可以。</strong>一个 Google 账号同一时间只能加入一个家庭组。如需更换家庭组，需先退出当前家庭组。</p>` },

  // ═══ 二、卡密与续费 ═══
  { category: '卡密与续费', question: '卡密前缀分别代表什么？', sortOrder: 200, answer: `<ul><li><strong>JZ 开头：</strong>进组卡密。新用户专用，用于首次加入家庭组。</li><li><strong>CX 开头：</strong>长效换号卡密。可在多个账号间切换使用，永久有效。</li><li><strong>HH 开头：</strong>续杯卡密。用于将 ULTRA 权益从旧账号迁移到新账号（一次性）。</li></ul>` },
  { category: '卡密与续费', question: 'JZ（进组）卡密怎么用？', sortOrder: 201, answer: `<p>在 <a href="https://bcai.site" target="_blank">bcai.site</a> 首页提交，输入卡密和目标 Gmail，系统自动发送家庭组邀请。</p>` },
  { category: '卡密与续费', question: 'HH / CX（续杯/换号）卡密怎么用？', sortOrder: 202, answer: `<p>在 <a href="https://bcai.site" target="_blank">bcai.site</a> 的「替换会员」入口提交，输入卡密 + 原 ULTRA 账号 + 目标白号，系统完成迁移后新账号即可补满额度。</p>` },
  { category: '卡密与续费', question: '额度用完了怎么续杯？', sortOrder: 203, answer: `<p>额度用完后，ULTRA 会员不会自动延续，需要使用续杯卡密将会员权益迁移到新账号：</p><ol><li>准备好续杯卡密（HH 或 CX 开头）和一个白号（Gmail 空号，无 ULTRA 权益）。</li><li>打开 <a href="https://bcai.site" target="_blank">bcai.site</a> → 选择「替换会员」。</li><li>输入卡密 + 原 ULTRA 账号 + 目标白号。</li><li>等待几分钟后出现「邀请已发送」→ 去目标账号确认家庭组邀请。</li><li>确认成功后新账号即补满所有额度。</li></ol>` },
  { category: '卡密与续费', question: '白号是什么？从哪里获取？', sortOrder: 204, answer: `<p>白号是指没有加入过任何家庭组、没有 ULTRA 权益的普通 Gmail 账号。</p><p>你可以自行注册新的 Gmail 账号作为白号使用，也可以在冰茶商店 <a href="https://bcai.store" target="_blank">bcai.store</a> 购买。</p>` },
  { category: '卡密与续费', question: '续杯后旧账号还能用吗？', sortOrder: 205, answer: `<p>续杯完成后，旧账号的 ULTRA 权益会被移除（退出家庭组），但账号本身仍然可用，只是额度会降为普通免费级别。</p>` },
  { category: '卡密与续费', question: 'CX 卡密和 HH 卡密有什么区别？', sortOrder: 206, answer: `<ul><li><strong>HH（续杯）卡密：</strong>一次性使用，用完即失效。</li><li><strong>CX（长效换号）卡密：</strong>可多次使用，在不同账号间反复切换，永久有效。适合频繁需要换号的用户。</li></ul>` },

  // ═══ 三、Antigravity IDE 使用 ═══
  { category: 'Antigravity IDE 使用', question: '网页登录成功，但 Antigravity IDE 没反应？', sortOrder: 300, answer: `<p>这是 Google 近期常见的 token 空回 bug，不是账号问题。解决步骤：</p><ol><li>先切换网络（开启<strong>全局模式 + TUN 模式</strong>）后重试。</li><li>如仍无反应，下载 Antigravity Tools 辅助登录：<a href="https://github.com/lbjlaq/Antigravity-Manager/releases" target="_blank">GitHub Releases</a>。</li></ol>` },
  { category: 'Antigravity IDE 使用', question: '首次登录需要手机验证怎么办？', sortOrder: 301, answer: `<p>首次使用几乎所有账号都需要验证。选择「手机验证」，然后：</p><ol><li>准备一个未在 Google 验证过的手机号。</li><li><strong>❌ 不要使用中国手机号</strong>（会拒收验证短信）。</li><li><strong>✅ 推荐：</strong>可在冰茶商店购买虚拟美国手机号：<a href="https://bcai.store" target="_blank">bcai.store</a>（¥1.5 起）。</li><li>填写美国号码后，在接码平台获取验证码完成验证即可。</li></ol>` },
  { category: 'Antigravity IDE 使用', question: 'Gemini 提示「无法使用」或「Something went wrong」？', sortOrder: 302, answer: `<p>原因：账号还没加入家庭组。</p><ol><li>开启美国 VPN。</li><li>打开 <a href="https://myaccount.google.com/u/2/people-and-sharing" target="_blank">Google People &amp; Sharing</a>。</li><li>按提示加入家庭组，成功后返回 Gemini 即可。</li></ol>` },
  { category: 'Antigravity IDE 使用', question: 'Antigravity 提示「额度已用完」但刚换的新号？', sortOrder: 303, answer: `<p>新账号加入家庭组后可能需要等待几分钟才能刷新额度。请尝试：</p><ol><li>关闭 Antigravity 并重新打开。</li><li>在 BCAI 插件侧边栏点击「刷新额度」。</li><li>如仍然显示无额度，检查是否成功加入了家庭组。</li></ol>` },
  { category: 'Antigravity IDE 使用', question: '对 VPN / 代理有什么要求？', sortOrder: 304, answer: `<ul><li>加入家庭组和使用 Gemini 服务时，<strong>必须使用美国节点 VPN</strong>。</li><li>建议开启<strong>全局模式 + TUN 模式</strong>以确保所有流量走代理。</li><li>避免使用免费或共享 VPN，IP 可能已被标记为不干净。</li></ul>` },
  { category: 'Antigravity IDE 使用', question: '支持哪些操作系统？', sortOrder: 305, answer: `<p>Antigravity IDE 支持 <strong>Windows、macOS 和 Linux</strong>。BCAI 插件在所有平台均可使用。</p>` },

  // ═══ 四、BCAI 插件 / Tools ═══
  { category: 'BCAI 插件 / Tools', question: 'BCAI 插件如何安装？', sortOrder: 400, answer: `<ol><li>打开 Antigravity IDE。</li><li>按 <code>Ctrl + Shift + X</code> 打开扩展面板。</li><li>搜索「BCAI」并点击安装，然后重启 IDE。</li></ol><p>安装后可管理多账号、自动切换、查看额度等。</p>` },
  { category: 'BCAI 插件 / Tools', question: '切换账号提示「账号无资格获取官方数据」？', sortOrder: 401, answer: `<p>这是因为账号被 Google 临时风控限制。解除步骤：</p><ol><li>点击「预热账号」→ 弹出「账号已禁用」提示 → 点击「详情」→ 点击「解除链接」。</li><li>点击「查看原因」。</li><li>复制跳转链接，在浏览器中完成 Google 官方验证。</li><li>验证成功后直接重新登录即可。</li></ol>` },
  { category: 'BCAI 插件 / Tools', question: 'BCAI 插件有什么核心功能？', sortOrder: 402, answer: `<ul><li><strong>多账号管理</strong>：一键添加和切换多个 Google 账号。</li><li><strong>额度监控</strong>：实时查看各账号的 Gemini / Claude 剩余配额。</li><li><strong>自动轮换</strong>：额度用完时自动切换到有配额的账号，避免断流。</li><li><strong>一键接管</strong>：自动配置 IDE 代理地址，无需手动修改设置。</li></ul>` },
  { category: 'BCAI 插件 / Tools', question: '插件显示「代理未启动」怎么办？', sortOrder: 403, answer: `<ol><li>在 BCAI 侧边栏点击「启动代理」按钮。</li><li>如果仍然无法启动，检查系统是否安装了 Node.js（建议 v18+）。</li><li>查看是否有其他程序占用了端口 60670 / 60671。</li></ol>` },

  // ═══ 五、API 接入 ═══
  { category: 'API 接入', question: 'API 如何接入使用？', sortOrder: 500, answer: `<p>冰茶 API 平台：<a href="https://bcai.online" target="_blank">bcai.online</a></p><ol><li>注册并获取 API Key。</li><li>将应用的 Base URL 替换为 <code>https://bcai.online</code>。</li></ol><p>支持 GPT、Claude、Gemini 等 30+ 模型，国内直连。</p>` },
  { category: 'API 接入', question: 'API 支持哪些模型？', sortOrder: 501, answer: `<p>支持包括但不限于：</p><ul><li><strong>Google：</strong>Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 Flash</li><li><strong>Anthropic：</strong>Claude 4 Sonnet, Claude 3.5 Sonnet, Claude 3.5 Haiku</li><li><strong>OpenAI：</strong>GPT-4o, GPT-4o-mini, o1, o3-mini</li></ul><p>具体可用模型列表请登录 <a href="https://bcai.online" target="_blank">bcai.online</a> 查看。</p>` },
  { category: 'API 接入', question: 'API 有调用限制吗？', sortOrder: 502, answer: `<p>按账号套餐不同有不同的速率限制和配额上限，具体请参阅 API 平台的定价说明。</p>` },

  // ═══ 六、订单与售后 ═══
  { category: '订单与售后', question: '下单后多久到账？', sortOrder: 600, answer: `<ul><li><strong>卡密类：</strong>支付成功后秒发到账，可在订单页面查看。</li><li><strong>账号类：</strong>支付后系统自动交付，正常 1-5 分钟到账。如超过 10 分钟未收到，请联系售后 @阿厌。</li></ul>` },
  { category: '订单与售后', question: '如何查询订单进度？', sortOrder: 601, answer: `<p>打开 <a href="https://bcai.site" target="_blank">bcai.site</a> → 点击「查询进度」→ 输入卡密查看状态（等待处理 / 处理中 / 已完成 / 失败）。</p>` },
  { category: '订单与售后', question: '账号被封禁了怎么办？', sortOrder: 602, answer: `<p>如果出现「账号已禁用」提示：</p><ol><li>点击「预热账号」尝试自动解封。</li><li>如自动解除失败，联系售后群 @阿厌 提供账号信息协助处理。</li></ol><p>⚠️ <strong>注意：</strong>因反代、共享账号、异常操作等导致的封禁不在质保范围内。</p>` },
  { category: '订单与售后', question: '售后处理步骤', sortOrder: 603, answer: `<ol><li>加入售后群（在群里 @阿厌 说明情况）。</li><li>提供订单截图 + 账号信息 + 问题描述。</li><li>客服会在 1 小时内响应处理。</li></ol>` },
  { category: '订单与售后', question: '支持退款吗？', sortOrder: 604, answer: `<ul><li>卡密类商品一经售出不支持退款（数字商品特殊性）。</li><li>如果收到的账号无法正常使用，可联系售后 @阿厌 免费换号处理。</li></ul>` },
  { category: '订单与售后', question: '账号被封禁一般是什么原因？', sortOrder: 605, answer: `<p>常见封禁原因包括：</p><ul><li>使用不干净的代理 IP（被大量用户共享）。</li><li>短时间内频繁切换 IP 或地区。</li><li>将账号凭证分享给多人同时使用。</li><li>使用自动化脚本大量调用。</li></ul><p><strong>建议：</strong>使用稳定的美国 VPN、避免频繁切换节点、不要共享账号。</p>` },

  // ═══ 七、其他 ═══
  { category: '其他', question: '虚拟手机号怎么获取？', sortOrder: 700, answer: `<p>可在冰茶商店 <a href="https://bcai.store" target="_blank">bcai.store</a> 搜索购买。</p><p>购买后在接码平台（如 <code>2fa.cn</code> / <code>2fa.live</code> / <code>2fa.vip</code>）输入密钥获取验证码。</p>` },
  { category: '其他', question: '接码平台怎么用？', sortOrder: 701, answer: `<ol><li>在冰茶商店购买虚拟手机号后，会收到一个密钥。</li><li>打开接码平台（如 <a href="https://2fa.live" target="_blank">2fa.live</a>）。</li><li>输入密钥，平台会显示该号码收到的最新验证码。</li><li>将验证码复制到 Google 验证页面即可。</li></ol>` },
  { category: '其他', question: '有客服联系方式吗？', sortOrder: 702, answer: `<ul><li><strong>售后群：</strong>请在购买页面获取群二维码或链接。</li><li><strong>客服：</strong>群内 @阿厌。</li><li><strong>工作时间：</strong>一般 1 小时内响应。</li></ul>` },
];

async function main() {
  console.log('🗑  Deleting all existing FAQ items...');
  const deleted = await prisma.faqItem.deleteMany();
  console.log(`   Deleted ${deleted.count} items\n`);

  console.log(`📝 Inserting ${FAQ_DATA.length} new FAQ items...\n`);
  let currentCat = '';
  for (const item of FAQ_DATA) {
    if (item.category !== currentCat) {
      currentCat = item.category;
      console.log(`  📂 ${currentCat}`);
    }
    await prisma.faqItem.create({
      data: {
        category: item.category,
        question: item.question,
        answer: item.answer,
        sortOrder: item.sortOrder,
        published: true,
      },
    });
    console.log(`    ✅ ${item.question}`);
  }

  const total = await prisma.faqItem.count();
  console.log(`\n🎉 Done! ${total} FAQ items in database.`);
  console.log('   Visit https://bcai.site/faq to verify.');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
