---
name: codex-skin
description: 为 Codex/ChatGPT 桌面端设计并注入自定义皮肤(主题/换肤/还原)。当用户想改 Codex 桌面端外观、应用/修改/移除皮肤时使用。依赖冰茶AI客户端开启的本机 CDP 皮肤调试通道。
---

# Codex 皮肤(冰茶AI 皮肤通道)

通过本机回环 CDP 通道给 Codex 桌面端注入用户自己设计的皮肤。皮肤的方向、素材、审美完全由你和用户对话决定;本 skill 只规定流程与安全护栏。不修改官方安装包,随时可还原。

## 路径约定

- 通道状态:`~/.bingchaai/codex-skin/state.json` → `{"enabled": bool, "port": int}`
- 注入脚本:`~/.bingchaai/codex-skin/skill/inject.mjs`(需 Node ≥ 22,零依赖)
- 皮肤产物:`~/.bingchaai/codex-skin/themes/<主题名>/skin.css`(+ 可选 `extra.js`)

## 1. 前置检查

1. 读 `state.json`。文件不存在或 `enabled=false` → 引导用户:打开冰茶AI客户端 → Codex 设置 → 开启「皮肤调试通道」,然后重试。
2. `curl -s http://127.0.0.1:<port>/json/version` 确认通道可达。不可达 → Codex 未带调试端口运行,引导用户在冰茶里点「重启 Codex 生效」。

## 2. 设计

- 先和用户确认方向(参考图 / 主色 / 氛围 / 文案),小步迭代,不要一次生成大而全。
- 皮肤写入 `~/.bingchaai/codex-skin/themes/<主题名>/skin.css`,反复修改同一份文件。
- 图片素材转成 data URL 内联进 CSS;payload 不得引用任何远程资源。
- 纯配色/背景不依赖具体 DOM,最稳;针对 Codex 界面结构的选择器先注入后截图验证,失配就降级。
- 需要 DOM 装饰(角标、贴纸、签名等)时另写 `extra.js`:必须幂等(重复执行先清理旧实例),并把清理函数 push 进 `window.__BCAI_SKIN__.cleanups`,否则 `--remove` 无法完整还原。

## 3. 注入 / 验证 / 迭代

```bash
node ~/.bingchaai/codex-skin/skill/inject.mjs --css <skin.css> [--js <extra.js>] [--screenshot <out.png>]
```

- 默认注入一次;加 `--screenshot` 顺手截图给用户确认效果。
- `--verify` 只做安装自检(样式在位、页面无横向溢出),输出 JSON。
- `--watch` 常驻:页面导航/刷新后自动重注入,长期使用建议后台运行。
- 改完 css/js 重新执行同一命令即可,毫秒级生效。
- 端口默认从 `state.json` 读取,也可用 `--port` 显式指定。

## 4. 还原

- `node ~/.bingchaai/codex-skin/skill/inject.mjs --remove` 即刻还原官方外观;
- 或引导用户在冰茶里关闭「皮肤调试通道」并重启 Codex,重启后零残留。

## 护栏(必须遵守)

- 装饰层一律 `pointer-events: none`;不遮挡、不替换、不禁用任何原生控件(侧栏、建议卡、项目选择器、输入框)。
- 不修改 Codex 官方安装目录、二进制、`app.asar`;不碰用户聊天数据与登录态。
- 不读取、不外传页面内容;注入 payload 中不得发起网络请求。
- Codex 更新后界面结构可能变化:先 `--verify` / 截图确认,再决定是否修选择器。

---

注入脚本改编自 [Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)(MIT License)。
