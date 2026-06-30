package webdav

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const requestTimeout = 60 * time.Second

// httpDoer 抽象 http.Client,便于单测注入 mock WebDAV 服务器。
type httpDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Connection 是建客户端所需的连接信息(已归一化或将被归一化)。
type Connection struct {
	BaseURL   string
	Username  string
	Password  string
	RemoteDir string
}

// Error 是本包的统一错误类型,Op 标识失败环节,便于上层归类与日志。
type Error struct {
	Op  string
	Msg string
}

func (e *Error) Error() string {
	if e.Op == "" {
		return e.Msg
	}
	return e.Op + ": " + e.Msg
}

var (
	errEmptyURL              = &Error{Op: "normalize_url", Msg: "WebDAV 地址不能为空"}
	errBadScheme             = &Error{Op: "normalize_url", Msg: "WebDAV 地址必须以 http 或 https 开头"}
	errEmptyRemoteDir        = &Error{Op: "normalize_dir", Msg: "WebDAV 远端目录不能为空"}
	errRemoteDirBackslash    = &Error{Op: "normalize_dir", Msg: "WebDAV 远端目录不能包含反斜杠"}
	errRemoteDirEmptySegment = &Error{Op: "normalize_dir", Msg: "WebDAV 远端目录不能包含空路径段"}
	errRemoteDirTraversal    = &Error{Op: "normalize_dir", Msg: "WebDAV 远端目录不能包含路径穿越片段"}
	errEmptyUsername         = &Error{Op: "connect", Msg: "WebDAV 账号不能为空"}
	errEmptyPassword         = &Error{Op: "connect", Msg: "WebDAV 应用密码不能为空"}
)

// Client 是一个最小 WebDAV 客户端:Basic Auth + PUT/GET 一个 bundle。
type Client struct {
	http      httpDoer
	baseURL   string // 已归一化,末尾带 '/'
	username  string
	password  string
	remoteDir string // 已归一化,无首尾 '/'
}

// NewClient 用归一化后的 Connection 建客户端。client 为 nil 时用默认带超时的 http.Client。
// 注入的 http.Client 仅与业务 WebDAV 服务端通信,不触碰任何租号/网关出口路径。
func NewClient(conn Connection, client httpDoer) (*Client, error) {
	baseURL, err := NormalizeBaseURL(conn.BaseURL)
	if err != nil {
		return nil, err
	}
	remoteDir, err := NormalizeRemoteDir(conn.RemoteDir)
	if err != nil {
		return nil, err
	}
	username := strings.TrimSpace(conn.Username)
	if username == "" {
		return nil, errEmptyUsername
	}
	if conn.Password == "" {
		return nil, errEmptyPassword
	}
	if client == nil {
		client = &http.Client{Timeout: requestTimeout}
	}
	return &Client{
		http:      client,
		baseURL:   baseURL,
		username:  username,
		password:  conn.Password,
		remoteDir: remoteDir,
	}, nil
}

// UploadBundle 把 data PUT 到 <baseURL><remoteDir>/<fileName>,上传前确保远端目录存在。
func (c *Client) UploadBundle(fileName string, data []byte) error {
	if err := validateBundleName(fileName); err != nil {
		return err
	}
	if err := c.ensureRemoteDir(); err != nil {
		return err
	}
	req, err := c.newRequest(http.MethodPut, c.filePath(fileName), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(data))
	resp, err := c.http.Do(req)
	if err != nil {
		return &Error{Op: "upload", Msg: err.Error()}
	}
	defer drain(resp)
	if !is2xx(resp.StatusCode) {
		return &Error{Op: "upload", Msg: fmt.Sprintf("上传 WebDAV 备份失败: HTTP %d", resp.StatusCode)}
	}
	return nil
}

// DownloadBundle GET <baseURL><remoteDir>/<fileName> 的字节内容。
func (c *Client) DownloadBundle(fileName string) ([]byte, error) {
	if err := validateBundleName(fileName); err != nil {
		return nil, err
	}
	req, err := c.newRequest(http.MethodGet, c.filePath(fileName), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Op: "download", Msg: err.Error()}
	}
	defer drain(resp)
	if !is2xx(resp.StatusCode) {
		return nil, &Error{Op: "download", Msg: fmt.Sprintf("读取 WebDAV 备份失败: HTTP %d", resp.StatusCode)}
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &Error{Op: "download", Msg: "读取 WebDAV 备份内容失败: " + err.Error()}
	}
	return body, nil
}

// ensureRemoteDir 逐级 MKCOL 建出 remoteDir(幂等:已存在的 405/已建的 2xx 都放过)。
func (c *Client) ensureRemoteDir() error {
	var cur string
	for _, part := range strings.Split(c.remoteDir, "/") {
		if part == "" {
			continue
		}
		if cur != "" {
			cur += "/"
		}
		cur += part
		req, err := c.newRequest("MKCOL", c.baseURL+cur, nil)
		if err != nil {
			return err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return &Error{Op: "mkcol", Msg: err.Error()}
		}
		code := resp.StatusCode
		drain(resp)
		// 201 新建、405 已存在(非集合冲突)、2xx 皆视为就绪。
		if is2xx(code) || code == http.StatusMethodNotAllowed {
			continue
		}
		return &Error{Op: "mkcol", Msg: fmt.Sprintf("创建 WebDAV 远端目录失败: HTTP %d", code)}
	}
	return nil
}

func (c *Client) filePath(fileName string) string {
	return c.baseURL + c.remoteDir + "/" + fileName
}

func (c *Client) newRequest(method, urlStr string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequest(method, urlStr, body)
	if err != nil {
		return nil, &Error{Op: "request", Msg: err.Error()}
	}
	req.SetBasicAuth(c.username, c.password)
	return req, nil
}

// validateBundleName 拒绝空名 / 含路径分隔符 / 路径穿越的文件名(防越出 remoteDir)。
func validateBundleName(fileName string) error {
	name := strings.TrimSpace(fileName)
	if name == "" {
		return &Error{Op: "validate", Msg: "bundle 文件名不能为空"}
	}
	if name != fileName {
		return &Error{Op: "validate", Msg: "bundle 文件名不能含首尾空白"}
	}
	if strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return &Error{Op: "validate", Msg: "bundle 文件名不能包含路径分隔符"}
	}
	return nil
}

func is2xx(code int) bool { return code >= 200 && code < 300 }

func drain(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}
