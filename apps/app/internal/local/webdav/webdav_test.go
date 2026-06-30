package webdav

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- Config persistence ----------

func TestConfigStoreLoadDefaultsWhenMissing(t *testing.T) {
	dir := t.TempDir()
	store := NewConfigStore(dir)

	got := store.Load()
	want := DefaultConfig()
	if got != want {
		t.Fatalf("Load() defaults = %+v, want %+v", got, want)
	}
	// 缺省时不应写盘
	if _, err := os.Stat(filepath.Join(dir, configFileName)); !os.IsNotExist(err) {
		t.Fatalf("Load() must not create file when missing, stat err = %v", err)
	}
}

func TestConfigStoreSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := NewConfigStore(dir)

	in := Config{
		Enabled:   true,
		URL:       "https://dav.jianguoyun.com/dav/",
		Username:  "alice@example.com",
		Password:  "app-secret",
		RemoteDir: "gfa-backups",
	}
	if err := store.Save(in); err != nil {
		t.Fatalf("Save() err = %v", err)
	}
	got := store.Load()
	if got != in {
		t.Fatalf("round-trip = %+v, want %+v", got, in)
	}
	// 文件应以 0600 落盘(含密码)
	info, err := os.Stat(filepath.Join(dir, configFileName))
	if err != nil {
		t.Fatalf("stat err = %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config perm = %o, want 600", perm)
	}
}

func TestConfigStoreLoadCorruptFallsBackToDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, configFileName), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := NewConfigStore(dir).Load()
	if got != DefaultConfig() {
		t.Fatalf("corrupt Load() = %+v, want defaults", got)
	}
}

// ---------- URL / remote dir normalization ----------

func TestNormalizeBaseURL(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{" https://dav.jianguoyun.com/dav/ ", "https://dav.jianguoyun.com/dav/", false},
		{"https://dav.example.com/dav", "https://dav.example.com/dav/", false},
		{"", "", true},
		{"ftp://dav.example.com/dav/", "", true},
	}
	for _, c := range cases {
		got, err := NormalizeBaseURL(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("NormalizeBaseURL(%q) expected error", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizeBaseURL(%q) err = %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("NormalizeBaseURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeRemoteDir(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{" /gfa-backups/ ", "gfa-backups", false},
		{"a/b/c", "a/b/c", false},
		{"", "", true},
		{"../escape", "", true},
		{"dir\\with\\backslash", "", true},
		{"a//b", "", true},
	}
	for _, c := range cases {
		got, err := NormalizeRemoteDir(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("NormalizeRemoteDir(%q) expected error", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizeRemoteDir(%q) err = %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("NormalizeRemoteDir(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ---------- Upload / download against a mock WebDAV server ----------

// newClient 用真实 httptest 服务器的 URL 建客户端(默认注入的 http.Client 即可命中本地服务器)。
func testConn(serverURL string) Connection {
	return Connection{
		BaseURL:   serverURL + "/",
		Username:  "u",
		Password:  "p",
		RemoteDir: "bundles",
	}
}

func wantBasicAuth(t *testing.T, r *http.Request) {
	t.Helper()
	got := r.Header.Get("Authorization")
	exp := "Basic " + base64.StdEncoding.EncodeToString([]byte("u:p"))
	if got != exp {
		t.Errorf("auth header = %q, want %q", got, exp)
	}
}

func TestUploadBundlePutsWithBasicAuth(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "MKCOL":
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			wantBasicAuth(t, r)
			gotMethod = r.Method
			gotPath = r.URL.Path
			gotBody = readAll(t, r)
			w.WriteHeader(http.StatusCreated)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	c, err := NewClient(testConn(srv.URL), srv.Client())
	if err != nil {
		t.Fatalf("NewClient err = %v", err)
	}
	payload := []byte("hello-bundle")
	if err := c.UploadBundle("backup.zip", payload); err != nil {
		t.Fatalf("UploadBundle err = %v", err)
	}
	if gotMethod != http.MethodPut {
		t.Fatalf("method = %q, want PUT", gotMethod)
	}
	if !strings.HasSuffix(gotPath, "/bundles/backup.zip") {
		t.Fatalf("path = %q, want suffix /bundles/backup.zip", gotPath)
	}
	if string(gotBody) != string(payload) {
		t.Fatalf("body = %q, want %q", gotBody, payload)
	}
}

func TestDownloadBundleGetsWithBasicAuth(t *testing.T) {
	const body = "downloaded-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		wantBasicAuth(t, r)
		if !strings.HasSuffix(r.URL.Path, "/bundles/backup.zip") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c, err := NewClient(testConn(srv.URL), srv.Client())
	if err != nil {
		t.Fatalf("NewClient err = %v", err)
	}
	got, err := c.DownloadBundle("backup.zip")
	if err != nil {
		t.Fatalf("DownloadBundle err = %v", err)
	}
	if string(got) != body {
		t.Fatalf("download = %q, want %q", got, body)
	}
}

func TestDownloadBundleNotFoundIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c, _ := NewClient(testConn(srv.URL), srv.Client())
	if _, err := c.DownloadBundle("missing.zip"); err == nil {
		t.Fatal("DownloadBundle on 404 should error")
	}
}

func TestUploadBundleNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "MKCOL" {
			w.WriteHeader(http.StatusCreated)
			return
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c, _ := NewClient(testConn(srv.URL), srv.Client())
	if err := c.UploadBundle("backup.zip", []byte("x")); err == nil {
		t.Fatal("UploadBundle on 403 should error")
	}
}

func TestNewClientRejectsBadConnection(t *testing.T) {
	if _, err := NewClient(Connection{}, nil); err == nil {
		t.Fatal("NewClient with empty connection should error")
	}
}

func TestUploadBundleRejectsBadFileName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("server must not be hit for bad file name; got %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	c, _ := NewClient(testConn(srv.URL), srv.Client())
	for _, bad := range []string{"", "a/b.zip", "../escape.zip", "dir\\x.zip"} {
		if err := c.UploadBundle(bad, []byte("x")); err == nil {
			t.Errorf("UploadBundle(%q) should error", bad)
		}
	}
}

func readAll(t *testing.T, r *http.Request) []byte {
	t.Helper()
	defer r.Body.Close()
	buf := make([]byte, 0, 64)
	tmp := make([]byte, 32)
	for {
		n, err := r.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return buf
}
