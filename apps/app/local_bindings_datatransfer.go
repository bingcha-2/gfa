package main

// 数据迁移 bundle（备份/换机）Wails 绑定 —— 仅薄薄委托给 hub。
// bundle 是版本化 JSON 文本,跨 Wails 边界用 string 传(前端可直接落盘/读盘)。
// 红线:只打包/还原本地配置与实例库,绝不导出 token 出口路径 / 远程租号。

// LocalExportDataBundle 导出「配置 + 实例库」为版本化 JSON 文本。
func (a *App) LocalExportDataBundle() (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	data, err := localHub.ExportDataBundle()
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// LocalImportDataBundle 从 JSON 文本还原本地,返回导入的实例数。
func (a *App) LocalImportDataBundle(bundleJSON string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.ImportDataBundle([]byte(bundleJSON))
}
