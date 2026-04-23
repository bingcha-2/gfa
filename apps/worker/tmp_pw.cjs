const { chromium } = require('playwright');
const path = require('path');

async function checkFile(fileName) {
  const fileUrl = 'file://' + path.resolve(__dirname, '..', fileName);
  console.log('--- checking', fileName, '---');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(fileUrl);
  
  const cardDebug = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    return Array.from(links).map((link) => {
      const href = link.getAttribute("href") ?? "";
      const card = link.closest("li, [data-member], .member-card") ?? link.parentElement;
      const cardDescendants = card ? Array.from(card.querySelectorAll("*")) : [];
      const leafTexts = cardDescendants
        .filter((c) => c.children.length === 0 && !link.contains(c))
        .map((c) => c.textContent?.trim() ?? "")
        .filter((t) => t.length > 0)
        .slice(0, 10);
      const nameEl = cardDescendants.find((child) => {
        if (link.contains(child)) return false;
        if (child.children.length > 0) return false;
        const text = child.textContent?.trim() ?? "";
        return (text.length > 1 && text.length < 80 && !text.includes("@") && !text.toLowerCase().includes("family member") && !/^\d+$/.test(text));
      });
      const displayName = nameEl?.textContent?.trim() ?? "";
      return { href, displayName, leafTexts };
    });
  });
  console.log(JSON.stringify(cardDebug, null, 2));
  await browser.close();
}

(async () => {
   await checkFile('1.html');
   await checkFile('2.html');
})();
