package main

import "bcai-wails/internal/local/webdav"

// WebDAV 备份同步 Wails 绑定 —— 仅薄薄委托给 hub。
// 红线:WebDAV 仅同步本地配置/实例 bundle,与远程租号 / 网关出口物理隔离。

func (a *App) LocalGetWebDAVConfig() (webdav.Config, error) {
	if err := ensureLocal(); err != nil {
		return webdav.Config{}, err
	}
	return localHub.GetWebDAVConfig(), nil
}

func (a *App) LocalSetWebDAVConfig(cfg webdav.Config) (webdav.Config, error) {
	if err := ensureLocal(); err != nil {
		return webdav.Config{}, err
	}
	return localHub.SetWebDAVConfig(cfg)
}

// LocalWebDAVUploadBackup 把当前本地 bundle 上传到 WebDAV。
func (a *App) LocalWebDAVUploadBackup() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.WebDAVUploadBackup()
}

// LocalWebDAVDownloadBackup 从 WebDAV 下载 bundle 并还原本地,返回导入的实例数。
func (a *App) LocalWebDAVDownloadBackup() (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.WebDAVDownloadBackup()
}
