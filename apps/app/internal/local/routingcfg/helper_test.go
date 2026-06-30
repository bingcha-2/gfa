package routingcfg

import (
	"os"
	"path/filepath"
)

// writeRaw 直接写入配置文件原始内容(测试损坏文件回退用)。
func writeRaw(dir, content string) error {
	return os.WriteFile(filepath.Join(dir, fileName), []byte(content), 0o600)
}
