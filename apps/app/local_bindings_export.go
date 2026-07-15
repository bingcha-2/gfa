package main

import (
	"os"
	"strings"

	"bcai-wails/internal/local/account"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 导出账号到文件 —— 用【原生保存对话框】而非浏览器 blob 下载。
//
// 为什么:前端原来用 Blob + <a download> 触发下载,这在 Wails WebView 里不生效
//(WebView 不走浏览器下载栈)——表现就是「点了导出没反应、也没文件」。改为后端弹
// runtime.SaveFileDialog 让用户选路径,再由 Go 直接落盘。
//
// 返回保存后的绝对路径;用户取消对话框返回空串(前端据此静默不提示)。

// exportAccountsToFile 取导出 JSON → 弹原生保存框 → 写文件。ids 为空=全部。
func (a *App) exportAccountsToFile(p account.Provider, ids []string, defaultName string) (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	data, err := localHub.Export(p, ids)
	if err != nil {
		return "", err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:                "导出账号为 JSON",
		DefaultFilename:      defaultName,
		CanCreateDirectories: true,
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON 文件 (*.json)", Pattern: "*.json"},
		},
	})
	if err != nil {
		return "", err
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil // 用户取消
	}
	// 0600:导出含凭证,别给同机其他用户读。
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// LocalExportCodexAccountsToFile 导出 codex 账号到用户选定的文件,返回保存路径(取消=空串)。
func (a *App) LocalExportCodexAccountsToFile(ids []string) (string, error) {
	return a.exportAccountsToFile(account.ProviderCodex, ids, "codex-accounts.json")
}

// LocalExportAntigravityAccountsToFile 导出 antigravity 账号到用户选定的文件,返回保存路径(取消=空串)。
func (a *App) LocalExportAntigravityAccountsToFile(ids []string) (string, error) {
	return a.exportAccountsToFile(account.ProviderAntigravity, ids, "antigravity-accounts.json")
}
