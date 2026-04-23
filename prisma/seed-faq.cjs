// Seed script: populates initial FAQ items from the Feishu wiki content.
// Run with: node prisma/seed-faq.cjs

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const faqs = [
  {
    category: "加入家庭组常见问题",
    question: "提示地区/国家不一致怎么办？",
    answer: `<p><strong>前置检查：</strong>确认你的网络节点已设置为<strong>美国</strong>。</p>
<p><strong>解决步骤：</strong></p>
<ol>
  <li>访问 <a href="https://payments.google.com/gp/w/home/settings" target="_blank">payments.google.com/gp/w/home/settings</a></li>
  <li>如果看到付款资料相关的错误，进入<strong>「设置」</strong>，滚动到底部，点击<strong>「关闭付款资料」</strong></li>
  <li>刷新家庭组邀请页，重新尝试加入</li>
</ol>`,
    sortOrder: 10,
    published: true,
  },
  {
    category: "反重力使用常见问题",
    question: "网页登录成功后 IDE 没反应？",
    answer: `<p><strong>原因：</strong>近期 Google 的一个 Bug 导致返回的 Token 为空。</p>
<p><strong>解决方案：</strong></p>
<ol>
  <li>尝试切换网络节点或开启 TUN/全局模式</li>
  <li>下载使用 <a href="https://github.com/lbjlaq/Antigravity-Manager/releases" target="_blank">Antigravity Tools</a></li>
  <li>在 Tools 应用中登录，Tools 捕获到 Token 后，IDE 会自动检测到账号，无需再次登录</li>
</ol>`,
    sortOrder: 20,
    published: true,
  },
  {
    category: "反重力使用常见问题",
    question: "登录完成后要求验证怎么办？",
    answer: `<p><strong>原因：</strong>Google 标准安全检测。</p>
<p><strong>解决方案：</strong></p>
<ol>
  <li>在反重力账号管理中开启「自动绕过验证码/验证」（目前仅 Tools 应用支持）</li>
  <li>如果需要手机号验证，可以使用自己的手机号或专门的接码平台（不要求是恢复号码）</li>
</ol>`,
    sortOrder: 30,
    published: true,
  },
  {
    category: "使用 Tools 常见问题",
    question: "切换账号时提示「账号无资格获取官方数据」？",
    answer: `<p><strong>原因：</strong>节点质量差或账号受限/需要手动验证。</p>
<p><strong>解决方案：</strong></p>
<ol>
  <li>使用更高质量的网络节点或本地代理 + 全局模式</li>
  <li>如果 Tools 显示「反代已禁用」或「账号需验证」：
    <ul>
      <li>点击<strong>「预热账号」</strong>，按提示完成「验证账号」或「复制验证链接」在浏览器中验证</li>
      <li>点击<strong>「查看原因」</strong>查看 Google 具体限制信息，按指引解决</li>
    </ul>
  </li>
</ol>`,
    sortOrder: 40,
    published: true,
  },
];

async function main() {
  console.log("Seeding FAQ items...");
  for (const faq of faqs) {
    // Skip if question already exists
    const existing = await prisma.faqItem.findFirst({ where: { question: faq.question } });
    if (existing) {
      console.log(`  ⏭ "${faq.question}" already exists, skipping.`);
      continue;
    }
    await prisma.faqItem.create({ data: faq });
    console.log(`  ✅ Created: "${faq.question}"`);
  }
  console.log("Done seeding FAQ items.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
