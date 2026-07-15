package gateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/gatewaycfg"
	"bcai-wails/internal/local/routingcfg"
)

// 生图模式必须落进网关生成的 cliproxy.yaml 的 disable-image-generation 键
//(on→false 全开 / off→true 全关 / images-only→chat 仅图像端点)。
func TestGateway_ImageGenModeWritesConfig(t *testing.T) {
	cases := []struct{ mode, wantLine string }{
		{gatewaycfg.ImageGenOn, "disable-image-generation: false"},
		{gatewaycfg.ImageGenOff, "disable-image-generation: true"},
		{gatewaycfg.ImageGenImagesOnly, "disable-image-generation: chat"},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			dir := t.TempDir()
			acc, err := account.OpenStore(dir + "/a.db")
			if err != nil {
				t.Fatal(err)
			}
			defer acc.Close()

			g := NewShared(acc, dir, routingcfg.StrategyPriority)
			if err := g.SetImageGenMode(c.mode); err != nil {
				t.Fatalf("SetImageGenMode(%q): %v", c.mode, err)
			}
			if _, err := g.Start(0); err != nil {
				t.Fatalf("Start: %v", err)
			}
			defer g.Stop()

			data, err := os.ReadFile(filepath.Join(dir, "cliproxy.yaml"))
			if err != nil {
				t.Fatalf("read cliproxy.yaml: %v", err)
			}
			if !strings.Contains(string(data), c.wantLine) {
				t.Fatalf("yaml missing %q; got:\n%s", c.wantLine, string(data))
			}
		})
	}
}

// 默认(未 SetImageGenMode)= 生图开 = disable-image-generation: false。
func TestGateway_ImageGenDefaultOn(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	g := NewShared(acc, dir, routingcfg.StrategyPriority)
	if _, err := g.Start(0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer g.Stop()

	data, err := os.ReadFile(filepath.Join(dir, "cliproxy.yaml"))
	if err != nil {
		t.Fatalf("read cliproxy.yaml: %v", err)
	}
	if !strings.Contains(string(data), "disable-image-generation: false") {
		t.Fatalf("default should be image-gen on (disable=false); got:\n%s", string(data))
	}
}
