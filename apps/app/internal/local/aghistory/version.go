package aghistory

import (
	"encoding/json"
	"os"
	"strings"
)

const defaultProductName = "Antigravity"

// InstalledVersionInfo 对齐 cockpit AntigravityInstalledVersionInfo。
type InstalledVersionInfo struct {
	ProductName string `json:"productName"`
	Version     string `json:"version"`
	AppPath     string `json:"appPath"`
	Source      string `json:"source"`
}

// ParseProductJSON 从 product.json 内容解析版本信息(纯函数)。
// 移植自 cockpit read_antigravity_product_json_metadata:
// 版本取 ideVersion -> version;产品名取 nameShort -> nameLong -> productName ->
// applicationName,缺省回退 "Antigravity"。无版本字段(或全空白)时 ok=false。
// AppPath 留空由调用方回填(纯函数不知道源路径)。
func ParseProductJSON(content []byte) (InstalledVersionInfo, bool) {
	var value map[string]any
	if err := json.Unmarshal(content, &value); err != nil {
		return InstalledVersionInfo{}, false
	}
	version, ok := jsonStringField(value, "ideVersion", "version")
	if !ok {
		return InstalledVersionInfo{}, false
	}
	productName, ok := jsonStringField(value, "nameShort", "nameLong", "productName", "applicationName")
	if !ok {
		productName = defaultProductName
	}
	return InstalledVersionInfo{
		ProductName: productName,
		Version:     version,
		Source:      "product.json",
	}, true
}

// ParsePlistDump 从 `plutil -p Info.plist` 风格的文本解析版本信息(纯函数)。
// 移植自 cockpit read_antigravity_macos_bundle_metadata + read_macos_plist_string:
// 版本取 CFBundleShortVersionString -> CFBundleVersion;产品名取 CFBundleDisplayName ->
// CFBundleName,缺省回退 "Antigravity"。无版本键时 ok=false。
func ParsePlistDump(content []byte) (InstalledVersionInfo, bool) {
	version, ok := plistDumpValue(content, "CFBundleShortVersionString", "CFBundleVersion")
	if !ok {
		return InstalledVersionInfo{}, false
	}
	productName, ok := plistDumpValue(content, "CFBundleDisplayName", "CFBundleName")
	if !ok {
		productName = defaultProductName
	}
	return InstalledVersionInfo{
		ProductName: productName,
		Version:     version,
		Source:      "Info.plist",
	}, true
}

// ReadVersionFile 读取调用方传入的版本文件路径并解析。
// 先按 product.json 解析,失败再按 plutil -p 文本解析;两者都不成则 ok=false。
// 成功时回填 AppPath=调用方传入的路径(对齐 cockpit 把源路径写进 app_path)。
func ReadVersionFile(path string) (InstalledVersionInfo, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return InstalledVersionInfo{}, false
	}
	if info, ok := ParseProductJSON(content); ok {
		info.AppPath = path
		return info, true
	}
	if info, ok := ParsePlistDump(content); ok {
		info.AppPath = path
		return info, true
	}
	return InstalledVersionInfo{}, false
}

// jsonStringField 返回首个非空白字符串字段(去空白后)。
func jsonStringField(value map[string]any, keys ...string) (string, bool) {
	for _, key := range keys {
		raw, exists := value[key]
		if !exists {
			continue
		}
		str, ok := raw.(string)
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(str); trimmed != "" {
			return trimmed, true
		}
	}
	return "", false
}

// plistDumpValue 在 plutil -p 文本里找 `"key" => "value"`,返回首个命中键的非空值。
func plistDumpValue(content []byte, keys ...string) (string, bool) {
	lines := strings.Split(string(content), "\n")
	for _, key := range keys {
		prefix := "\"" + key + "\""
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, prefix) {
				continue
			}
			idx := strings.Index(line, "=>")
			if idx < 0 {
				continue
			}
			val := strings.TrimSpace(line[idx+2:])
			val = strings.Trim(val, "\"")
			if val != "" {
				return val, true
			}
		}
	}
	return "", false
}
