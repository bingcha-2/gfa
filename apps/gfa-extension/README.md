# BCAI TOOLS

冰茶 AI 续航终端 — VS Code 插件版

## 功能

- **公共终端**: 卡密兑换进组、换号、自助售后、进度查询
- **管理控制台**: 管理员登录后可查看系统状态（完整管理面板逐步迁移中）

## 使用方法

1. 安装插件后，状态栏右下角会显示 `BCAI` 按钮
2. 点击按钮或使用命令面板 (`Ctrl+Shift+P`):
   - `BCAI: 打开管理控制台` — 打开管理面板
   - `BCAI: 打开公共终端` — 打开公共操作页面
   - `BCAI: 设置 API 地址` — 配置后端 API 地址
   - `BCAI: 登录` — 快速登录

## 配置

在 VS Code 设置中搜索 `bcai`:

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `bcai.apiBaseUrl` | `http://localhost:3001/api` | GFA API 服务器地址 |

## 开发

```bash
# 安装依赖
cd apps/gfa-extension
npm install
cd webview-ui && npm install && cd ..

# 构建
npm run build

# 打包 .vsix
npm run package
```

## 发布到 Open VSX

```bash
npx ovsx create-namespace bcai -p <YOUR_TOKEN>
npx ovsx publish bcai-tools-3.0.4.vsix -p <YOUR_TOKEN>
```
