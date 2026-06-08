# Design — 控制台（Console）

冰茶AI 控制台视觉系统。气质：**克制、确定、好读的内部运维工具**（Linear / Stripe Dashboard 的密度与一致感），与营销页**同源**——共用一颗琥珀强调色，但基底保持中性，不喧宾夺主。

> 范围：`apps/web/src/app/console/(dashboard)/*`（25 个页面，重度基于 shadcn）。
> 营销页（`/`、`/download`…）由 [DESIGN.md](DESIGN.md) 管，不归本文件。
> Register：**product**（design 服务于任务，工具应消失在任务里）。

---

## 诊断（为什么要重构）

1. **没有品牌识别**：`:root` 是原版 shadcn 黑白皮（`--primary: oklch(0.205 0 0)`，所有 chroma 全 0），看着像 shadcn 官方 demo，跟"冰茶"毫无关系。深色模式残留一处 `--sidebar-primary: oklch(0.488 0.243 264.376)`（一抹紫），是模板没删干净的脏值。
2. **每页各搞各的间距**：25 页顶层包裹五花八门——`mt-4` / `space-y-6` / `space-y-4` / `flex gap-6` / 啥都没有。没有统一的 PageHeader、没有统一竖向节奏。
3. **图表/状态色是灰阶**：`--chart-1..5` 全 chroma 0；状态全靠 shadcn 默认 badge variant，没有真正的语义色（成功/警告/危险/信息）。

## 策略

**Restrained + 单点琥珀。** 近黑白的中性基底（微暖，跟营销页同一暖调，但 chroma 极低，是工具不是奶油）。琥珀（`#ea580c`，与营销页同一颗）**只**用于：主操作按钮、当前选中/激活、焦点环、关键强调。再补一套**语义状态色**（成功 / 警告 / 危险 / 信息）承担"运维状态"语言。深色模式走深靛蓝，呼应客户端深色仪表盘。

橙是唯一高彩点睛色——**警告色专门挪到更黄的色相（hue ~78）**与琥珀（hue ~41，偏橙红）拉开，避免"主色＝警告色"撞车。

---

## Color（OKLCH）

替换 `globals.css` 的 `:root` 与 `.dark` 整块。

### Light

```css
:root {
  --radius: 0.625rem;

  --background:            oklch(0.986 0.003 70);   /* 内容区近白·微暖，非奶油 */
  --foreground:           oklch(0.220 0.012 50);    /* 暖近黑正文，对 bg ≥12:1 */
  --card:                 oklch(1 0 0);             /* 卡片纯白 */
  --card-foreground:      oklch(0.220 0.012 50);
  --popover:              oklch(1 0 0);
  --popover-foreground:   oklch(0.220 0.012 50);

  --muted:                oklch(0.967 0.004 65);    /* 次级面 / 斑马底 */
  --muted-foreground:     oklch(0.448 0.012 50);    /* 次要文字，对 bg ≈6:1 达 AA */
  --secondary:            oklch(0.967 0.004 65);
  --secondary-foreground: oklch(0.270 0.012 50);
  --accent:              oklch(0.955 0.006 60);      /* 中性 hover 底（shadcn 语义） */
  --accent-foreground:   oklch(0.270 0.012 50);

  --border:               oklch(0.903 0.005 65);
  --input:                oklch(0.903 0.005 65);

  --primary:              oklch(0.646 0.196 41);    /* 琥珀 #ea580c：主操作/选中/链接 */
  --primary-foreground:   oklch(0.995 0.010 90);
  --ring:                 oklch(0.646 0.196 41);    /* 焦点环=琥珀 */

  /* 语义状态色 */
  --success:              oklch(0.600 0.140 150);
  --success-foreground:   oklch(0.995 0.010 150);
  --warning:              oklch(0.740 0.140 78);    /* 更黄，与琥珀拉开 */
  --warning-foreground:   oklch(0.270 0.040 80);
  --destructive:          oklch(0.580 0.210 27);
  --destructive-foreground: oklch(0.995 0.010 27);
  --info:                 oklch(0.580 0.140 245);
  --info-foreground:      oklch(0.995 0.010 245);

  /* 状态软底（badge/选中底，统一 /0.12） */
  --primary-soft:         oklch(0.646 0.196 41 / 0.12);
  --success-soft:         oklch(0.600 0.140 150 / 0.14);
  --warning-soft:         oklch(0.740 0.140 78 / 0.16);
  --destructive-soft:     oklch(0.580 0.210 27 / 0.12);
  --info-soft:            oklch(0.580 0.140 245 / 0.12);

  /* 图表：琥珀锚定的分类色（非灰阶） */
  --chart-1: oklch(0.646 0.196 41);    /* 琥珀 */
  --chart-2: oklch(0.600 0.130 200);   /* 蓝青 */
  --chart-3: oklch(0.620 0.140 145);   /* 绿 */
  --chart-4: oklch(0.620 0.150 280);   /* 紫 */
  --chart-5: oklch(0.750 0.130 80);    /* 金 */

  /* 侧栏：第二中性层，比内容更暖/略沉，inset 分离感 */
  --sidebar:                    oklch(0.975 0.005 65);
  --sidebar-foreground:         oklch(0.300 0.012 50);
  --sidebar-primary:            oklch(0.646 0.196 41);
  --sidebar-primary-foreground: oklch(0.995 0.010 90);
  --sidebar-accent:             oklch(0.646 0.196 41 / 0.10);  /* 激活项软底 */
  --sidebar-accent-foreground:  oklch(0.553 0.176 38);          /* 激活项琥珀字 */
  --sidebar-border:             oklch(0.900 0.005 65);
  --sidebar-ring:               oklch(0.646 0.196 41);
}
```

### Dark（深靛蓝，呼应客户端）

```css
.dark {
  --background:            oklch(0.185 0.013 270);
  --foreground:           oklch(0.965 0.005 270);
  --card:                 oklch(0.215 0.016 270);
  --card-foreground:      oklch(0.965 0.005 270);
  --popover:              oklch(0.215 0.016 270);
  --popover-foreground:   oklch(0.965 0.005 270);

  --muted:                oklch(0.255 0.016 270);
  --muted-foreground:     oklch(0.720 0.014 272);    /* 对 card ≥4.5:1 */
  --secondary:            oklch(0.255 0.016 270);
  --secondary-foreground: oklch(0.965 0.005 270);
  --accent:               oklch(0.275 0.018 270);
  --accent-foreground:    oklch(0.965 0.005 270);

  --border:               oklch(1 0 0 / 9%);
  --input:                oklch(1 0 0 / 12%);

  --primary:              oklch(0.705 0.185 46);     /* 暗底提亮一档的琥珀 */
  --primary-foreground:   oklch(0.200 0.020 50);
  --ring:                 oklch(0.705 0.185 46);

  --success:              oklch(0.720 0.150 152);
  --success-foreground:   oklch(0.180 0.020 152);
  --warning:              oklch(0.800 0.130 80);
  --warning-foreground:   oklch(0.200 0.030 80);
  --destructive:          oklch(0.700 0.190 22);
  --destructive-foreground: oklch(0.180 0.020 22);
  --info:                 oklch(0.680 0.130 240);
  --info-foreground:      oklch(0.180 0.020 240);

  --primary-soft:         oklch(0.705 0.185 46 / 0.16);
  --success-soft:         oklch(0.720 0.150 152 / 0.18);
  --warning-soft:         oklch(0.800 0.130 80 / 0.18);
  --destructive-soft:     oklch(0.700 0.190 22 / 0.18);
  --info-soft:            oklch(0.680 0.130 240 / 0.18);

  --chart-1: oklch(0.705 0.185 46);
  --chart-2: oklch(0.680 0.120 200);
  --chart-3: oklch(0.700 0.130 150);
  --chart-4: oklch(0.700 0.140 285);
  --chart-5: oklch(0.800 0.120 82);

  --sidebar:                    oklch(0.165 0.012 270);
  --sidebar-foreground:         oklch(0.780 0.014 272);
  --sidebar-primary:            oklch(0.705 0.185 46);
  --sidebar-primary-foreground: oklch(0.200 0.020 50);
  --sidebar-accent:             oklch(0.705 0.185 46 / 0.16);
  --sidebar-accent-foreground:  oklch(0.800 0.160 55);
  --sidebar-border:             oklch(1 0 0 / 8%);
  --sidebar-ring:               oklch(0.705 0.185 46);
}
```

颜色规则：琥珀是唯一高彩色，**只**给 action / 选中 / 焦点 / 关键强调。运维状态用语义色（绿=正常/已接管，黄=待处理/警告，红=失败/危险，蓝=信息/进行中）。中性面上的次要文字一律 `--muted-foreground`，**不**再往浅灰走（这是现状最容易踩的对比度坑）。

---

## Typography

product register：**单字族 + 固定 rem 阶梯**（不用流式 clamp，工具在固定 DPI 下看）。

- 字族：`var(--font-sans)`（Geist）+ CJK 系统字（PingFang SC → Noto Sans SC）。ID/卡密/订单号用 `--font-mono`（Geist Mono）——本产品就是 CLI 工具，mono 是实义。
- 阶梯（比例 ~1.2，紧凑）：
  - 页面标题 h1：`1.5rem` / 650 / `-0.01em`
  - 区块标题 / CardTitle：`1.125rem` / 600
  - 指标大数：`1.875rem` / 650 / `tabular-nums`
  - 正文 / 表格：`0.875rem` / 1.5
  - 次要 / 描述：`0.8125rem` / `--muted-foreground`
  - 标签 / 徽章：`0.75rem` / 500
- 数字一律 `font-variant-numeric: tabular-nums`（指标、表格、计数对齐）。
- 禁：全大写正文、流式 clamp 标题、display 字体进 UI 标签。

## Layout & 页面骨架（这是修"很多页面样式有问题"的核心）

现状每页自定义包裹，是混乱根源。**统一两件事**：

1. **`<PageHeader>` 组件**（新增，约定每页第一个元素）：
   ```
   标题(h1) + 一句描述(muted)            [右侧 actions 槽：主按钮/筛选]
   ```
   贴着 header 下方，描述讲"这页帮你判断什么"，不是复述标题。
2. **统一竖向节奏**：layout 已给 `p-4 lg:p-6`；页面内容一律 `<div className="space-y-6">` 包裹，区块之间 `space-y-6`，区块内 `space-y-4`。**废除** `mt-4` / `space-y-4` / `flex gap-6` 各页乱用。

- 一维布局 flex+wrap，二维用 grid；指标网格 `grid gap-4 md:grid-cols-2 lg:grid-cols-3`。
- 卡片只在确实是最佳载体时用（指标瓦片、分组内容）。**禁套娃卡片**、禁千篇一律等大卡墙。表格不再裹一层多余卡片时直接用 `<Card>` 包整块。
- 语义化 z-index（沿用 shadcn 既有层级）。

## Components（状态必须配齐）

每个可交互组件都要有：default / hover / focus-visible / active / disabled / loading / error。现状缺一半。

- **Button**：Primary=实心琥珀（hover→`--primary` 加深+轻阴影）；Secondary=`--border` 描边 ghost；Destructive=红；标签遵循"动词+宾语"（保存设置 / 删除卡密）。
- **状态徽章（Badge）**：胶囊 + 8px 圆点 + 文字，映射到语义色软底。统一一张 `STATUS_MAP`：
  - 绿（success-soft）：`COMPLETED` `INVITE_SENT` `ACTIVE` 正常/已接管
  - 黄（warning-soft）：`MANUAL_REVIEW` `PENDING` 待处理/排队
  - 红（destructive-soft）：`FAILED` `FAILED_FINAL` `DISABLED` 失败/异常
  - 蓝（info-soft）：`RUNNING` `PROCESSING` 进行中
  - 灰（muted）：未知/默认
  替换现状散落的 `statusVariant()`，全站一个来源。
- **Table**：sticky header、行 hover=`--accent`、数字 `tabular-nums`、ID/订单号 `--font-mono text-xs`、可选斑马 `--muted`。长表分页/虚拟滚动。
- **指标卡**：icon（`--muted-foreground`）+ 标签 + 大数（`tabular-nums`）+ 一句描述。**异常类指标**（待人工/异常母号>0）数字与 icon 染 `--warning`/`--destructive`，0 时回中性——让"有事要管"一眼可见。**禁** big-number 渐变指标墙模板：这里是真运维数据、克制呈现。
- **Sidebar**：inset 变体；激活项=`--sidebar-accent` 软底 + `--sidebar-accent-foreground` 琥珀字（**不**用左色条，side-stripe ban）。分组标题（主控 / Rosetta / 系统）用 `--muted-foreground` 小标签。
- **Empty / Loading**：空态用 `<Empty>` 教用户下一步（不是"暂无数据"）；加载用 skeleton 占位，不是内容区中央转圈。
- **Toast**：`sonner richColors`，成功/失败映射语义色。

## Motion

product：150–250ms，只传达状态（hover/focus/选中/加载/展开），不做编排式入场。`prefers-reduced-motion: reduce` 一律降级直出。

## Bans（在通用 ban 之上）

灰阶图表；纯黑白脱离品牌；残留紫色脏 token；每页各自定义包裹间距；side-stripe callout；big-number 渐变指标墙；display 字体进 UI；内容中央转圈代替 skeleton；状态色硬塞高饱和到非激活态。

---

## 迁移清单（审完方案后执行，分阶段）

1. **Token 层（1 个文件，零视觉风险最高收益）**：替换 `globals.css` 的 `:root` + `.dark` 两块为上表；删除残留紫 `--sidebar-primary`。25 页**立即**统一获得琥珀+语义色，无需改页面。
2. **页面骨架**：新增 `<PageHeader>` 组件；逐页把顶层 `mt-4`/`space-y-*`/`flex gap-*` 换成 `<PageHeader> + <div className="space-y-6">`。可一页一页来，互不影响。
3. **状态系统**：抽出全局 `STATUS_MAP` + `<StatusBadge>`，替换各页 `statusVariant()`。
4. **图表**：图表组件接 `--chart-1..5`（已是分类琥珀色），无需逐图改色。
5. **组件状态补全**：Button/Table/Empty/Skeleton 的 hover/focus/loading 态对齐本规范。

阶段 1 一次提交即可让全站"换皮成功"；2–5 增量推进，每步可独立验证。
