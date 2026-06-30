package hub

import (
	"fmt"

	"bcai-wails/internal/local/webdav"
)

// WebDAV 备份同步的薄委托:配置持久化 + 把数据迁移 bundle 上传/下载到 WebDAV。
//
// webdav 是自包含包(配置持久化 + PUT/GET + Basic Auth + URL/dir 归一)。上传内容为
// ExportDataBundle 产出的版本化 bundle;下载后经 ImportDataBundle 还原。
//
// 红线:WebDAV 仅同步本地配置/实例 bundle,与远程租号 / 网关出口物理隔离。

// webdavBundleName 是 WebDAV 上的固定 bundle 文件名。
const webdavBundleName = "bcai-local-backup.json"

// GetWebDAVConfig 返回当前 WebDAV 同步配置(缺省回退默认:禁用)。
func (h *Hub) GetWebDAVConfig() webdav.Config { return h.webdav.Load() }

// SetWebDAVConfig 持久化 WebDAV 配置(0600),返回落盘后的值。
func (h *Hub) SetWebDAVConfig(cfg webdav.Config) (webdav.Config, error) {
	if err := h.webdav.Save(cfg); err != nil {
		return webdav.Config{}, err
	}
	return h.webdav.Load(), nil
}

// webdavClient 用当前配置建一个 WebDAV 客户端(未启用/缺地址时报错)。
func (h *Hub) webdavClient() (*webdav.Client, error) {
	cfg := h.webdav.Load()
	if !cfg.Enabled {
		return nil, fmt.Errorf("hub: WebDAV 同步未启用")
	}
	return webdav.NewClient(webdav.Connection{
		BaseURL:   cfg.URL,
		Username:  cfg.Username,
		Password:  cfg.Password,
		RemoteDir: cfg.RemoteDir,
	}, nil)
}

// WebDAVUploadBackup 把当前「配置 + 实例库」bundle 上传到 WebDAV。
func (h *Hub) WebDAVUploadBackup() error {
	c, err := h.webdavClient()
	if err != nil {
		return err
	}
	data, err := h.ExportDataBundle()
	if err != nil {
		return err
	}
	return c.UploadBundle(webdavBundleName, data)
}

// WebDAVDownloadBackup 从 WebDAV 下载 bundle 并还原本地,返回导入的实例数。
func (h *Hub) WebDAVDownloadBackup() (int, error) {
	c, err := h.webdavClient()
	if err != nil {
		return 0, err
	}
	data, err := c.DownloadBundle(webdavBundleName)
	if err != nil {
		return 0, err
	}
	return h.ImportDataBundle(data)
}
