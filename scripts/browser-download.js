// ====================================================
// 在 https://bcai.site/console 的 Chrome DevTools Console 中粘贴执行
// 会自动下载 accounts.json 和 family-groups.json 两个文件
// ====================================================
(async () => {
  const download = (name, text) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type:'application/json'}));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  console.log('⏳ 正在获取母号数据...');
  const acc = await fetch('/api/proxy/accounts', {headers:{accept:'application/json'}}).then(r=>r.text());
  download('accounts.json', acc);
  console.log('✅ accounts.json 已下载 (' + (acc.length/1024).toFixed(1) + 'KB)');

  console.log('⏳ 正在获取家庭组数据...');
  const fg = await fetch('/api/proxy/family-groups', {headers:{accept:'application/json'}}).then(r=>r.text());
  download('family-groups.json', fg);
  console.log('✅ family-groups.json 已下载 (' + (fg.length/1024).toFixed(1) + 'KB)');

  console.log('🎉 全部完成！请将下载的文件移动到: GFA/scripts/remote-data/ 目录');
})();
