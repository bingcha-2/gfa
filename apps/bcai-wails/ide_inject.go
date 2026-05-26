package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	// IDE settings.json 中的代理 URL 配置键
	IDECloudCodeURLKey = "jetski.cloudCodeUrl"
)

// IDEProduct 表示一个可注入的 IDE 产品
type IDEProduct struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Detected          bool   `json:"detected"`
	DetectedPath      string `json:"detectedPath"`
	Injected          bool   `json:"injected"`
	SupportsInjection bool   `json:"supportsInjection"`
	InjectionType     string `json:"injectionType"` // "settings" or "asar"
}

// IDEStatus 注入状态
type IDEStatus struct {
	Products         []IDEProduct `json:"products"`
	ProxyURL         string       `json:"proxyUrl"`
	IsLSProxyApplied bool         `json:"isLsProxyApplied"` // 所有 LS 是否已连接代理
}

var (
	ideInjectMu sync.Mutex
)

// DetectIDEProducts 检测所有支持的产品
func DetectIDEProducts(proxyPort int) IDEStatus {
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
	products := []IDEProduct{}

	// 1. Antigravity IDE (settings.json 注入)
	idePath := detectAntigravityIDEPath()
	ideSettingsPath := getIDESettingsPath()
	ideInjected := false
	if ideSettingsPath != "" {
		ideInjected = checkSettingsInjected(ideSettingsPath, proxyURL)
	}
	products = append(products, IDEProduct{
		ID:                "antigravity_ide",
		Name:              "Antigravity IDE",
		Detected:          idePath != "",
		DetectedPath:      idePath,
		Injected:          ideInjected,
		SupportsInjection: true,
		InjectionType:     "settings",
	})

	// 2. Antigravity Hub / Antigravity.app (asar 补丁)
	hubPath := detectAntigravityHubPath()
	hubInjected := false
	if hubPath != "" {
		asarPath := getAsarPath(hubPath)
		hubInjected = checkAsarPatchedForUs(asarPath, proxyURL)
	}
	products = append(products, IDEProduct{
		ID:                "antigravity_hub",
		Name:              "Antigravity Hub",
		Detected:          hubPath != "",
		DetectedPath:      hubPath,
		Injected:          hubInjected,
		SupportsInjection: true,
		InjectionType:     "asar",
	})

	return IDEStatus{
		Products:         products,
		ProxyURL:         proxyURL,
		IsLSProxyApplied: IsLSProxyApplied(proxyPort),
	}
}

// ======================== settings.json 注入 ========================

// getIDESettingsPath 返回 Antigravity IDE 的 settings.json 路径
func getIDESettingsPath() string {
	var base string
	switch runtime.GOOS {
	case "darwin":
		// 实际路径是 ~/Library/Application Support/Antigravity IDE/User/settings.json
		base = filepath.Join(os.Getenv("HOME"), "Library", "Application Support", "Antigravity IDE", "User")
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			appdata = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
		}
		base = filepath.Join(appdata, "Antigravity IDE", "User")
	default:
		base = filepath.Join(os.Getenv("HOME"), ".config", "Antigravity IDE", "User")
	}
	return filepath.Join(base, "settings.json")
}

// InjectIDESettings 注入 settings.json
func InjectIDESettings(proxyPort int) error {
	ideInjectMu.Lock()
	defer ideInjectMu.Unlock()

	settingsPath := getIDESettingsPath()
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", proxyPort)

	settings := make(map[string]interface{})

	// 读取现有设置
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		_ = json.Unmarshal(data, &settings)
	}

	// 注入代理 URL
	settings[IDECloudCodeURLKey] = proxyURL

	// 确保目录存在
	dir := filepath.Dir(settingsPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}

	// 写回
	newData, err := json.MarshalIndent(settings, "", "    ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}

	if err := os.WriteFile(settingsPath, newData, 0644); err != nil {
		return fmt.Errorf("写入失败: %w", err)
	}

	Log("[ide-inject] 已注入 IDE settings.json: %s = %s (path: %s)", IDECloudCodeURLKey, proxyURL, settingsPath)
	return nil
}

// RestoreIDESettings 恢复 settings.json（移除注入的代理配置）
func RestoreIDESettings() error {
	ideInjectMu.Lock()
	defer ideInjectMu.Unlock()

	settingsPath := getIDESettingsPath()
	settings := make(map[string]interface{})

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil // 文件不存在，无需恢复
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("解析 settings.json 失败: %w", err)
	}

	// 删除代理配置（与 timo 行为一致）
	delete(settings, IDECloudCodeURLKey)

	newData, err := json.MarshalIndent(settings, "", "    ")
	if err != nil {
		return fmt.Errorf("序列化失败: %w", err)
	}

	if err := os.WriteFile(settingsPath, newData, 0644); err != nil {
		return fmt.Errorf("写入失败: %w", err)
	}

	Log("[ide-inject] 已从 IDE settings.json 移除代理配置")
	return nil
}

// checkSettingsInjected 检查 settings.json 是否已注入
func checkSettingsInjected(settingsPath, proxyURL string) bool {
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return false
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		return false
	}
	val, ok := settings[IDECloudCodeURLKey]
	if !ok {
		return false
	}
	valStr, ok := val.(string)
	return ok && valStr == proxyURL
}

// ======================== 智能应用检测 ========================

// registryFindInstallPath 从 Windows 注册表 Uninstall 键查找应用安装路径
// 搜索 DisplayName 匹配 appName 的条目，返回 InstallLocation 或 exe 路径
func registryFindInstallPath(appName string) string {
	if runtime.GOOS != "windows" {
		return ""
	}
	roots := []string{
		`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	}
	for _, root := range roots {
		// /s 递归搜索, /f 过滤含 appName 的值, /d 只搜数据
		out, err := hideCmd("reg", "query", root, "/s", "/f", appName, "/d").Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			subkey := strings.TrimSpace(line)
			if !strings.HasPrefix(subkey, "HK") {
				continue
			}
			// 校验 DisplayName 确实包含目标名称
			dn := registryReadValue(subkey, "DisplayName")
			if dn == "" || !strings.Contains(dn, appName) {
				continue
			}
			// 优先读 InstallLocation
			if loc := registryReadValue(subkey, "InstallLocation"); loc != "" {
				if _, err := os.Stat(loc); err == nil {
					Log("[detect] 从注册表找到 %s: %s", appName, loc)
					return loc
				}
			}
			// 备选: DisplayIcon 通常包含 exe 路径
			if icon := registryReadValue(subkey, "DisplayIcon"); icon != "" {
				icon = strings.Split(icon, ",")[0]
				if _, err := os.Stat(icon); err == nil {
					Log("[detect] 从注册表 DisplayIcon 找到 %s: %s", appName, icon)
					return icon
				}
			}
		}
	}
	return ""
}

// registryReadValue 读取注册表键的 REG_SZ 值
func registryReadValue(key, valueName string) string {
	out, err := hideCmd("reg", "query", key, "/v", valueName).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, valueName) && strings.Contains(line, "REG_SZ") {
			parts := strings.SplitN(line, "REG_SZ", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}

// spotlightFindApp 使用 macOS Spotlight 索引按文件名查找 .app
func spotlightFindApp(appFileName string) string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	out, err := hideCmd("mdfind", fmt.Sprintf(`kMDItemFSName == "%s"`, appFileName)).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasSuffix(line, ".app") {
			if _, err := os.Stat(line); err == nil {
				Log("[detect] Spotlight 找到 %s: %s", appFileName, line)
				return line
			}
		}
	}
	return ""
}

// desktopFindApp 扫描 Linux .desktop 文件查找应用的 Exec 路径
func desktopFindApp(appName string) string {
	if runtime.GOOS != "linux" {
		return ""
	}
	dirs := []string{"/usr/share/applications"}
	if home := os.Getenv("HOME"); home != "" {
		dirs = append(dirs, filepath.Join(home, ".local", "share", "applications"))
	}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".desktop") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			content := string(data)
			if !strings.Contains(content, appName) {
				continue
			}
			for _, line := range strings.Split(content, "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "Exec=") {
					execPath := strings.TrimPrefix(line, "Exec=")
					execPath = strings.Fields(execPath)[0]
					execPath = strings.Trim(execPath, "\"'")
					if _, err := os.Stat(execPath); err == nil {
						Log("[detect] .desktop 找到 %s: %s", appName, execPath)
						return execPath
					}
				}
			}
		}
	}
	return ""
}

// ======================== IDE 路径检测 ========================

// detectAntigravityIDEPath 检测 Antigravity IDE 安装路径
// 优先级: 用户配置 > 注册表/Spotlight/.desktop > 硬编码路径
func detectAntigravityIDEPath() string {
	// 1. 用户自定义路径
	cfg := LoadConfig()
	if cfg.IDEPath != "" {
		if _, err := os.Stat(cfg.IDEPath); err == nil {
			return cfg.IDEPath
		}
	}

	// 2. 智能检测
	switch runtime.GOOS {
	case "windows":
		if loc := registryFindInstallPath("Antigravity IDE"); loc != "" {
			if strings.HasSuffix(strings.ToLower(loc), ".exe") {
				return loc
			}
			exe := filepath.Join(loc, "Antigravity IDE.exe")
			if _, err := os.Stat(exe); err == nil {
				return exe
			}
		}
	case "darwin":
		if p := spotlightFindApp("Antigravity IDE.app"); p != "" {
			return p
		}
	case "linux":
		if p := desktopFindApp("Antigravity IDE"); p != "" {
			return p
		}
	}

	// 3. 硬编码路径兜底
	switch runtime.GOOS {
	case "darwin":
		if _, err := os.Stat("/Applications/Antigravity IDE.app"); err == nil {
			return "/Applications/Antigravity IDE.app"
		}
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		programFiles := os.Getenv("ProgramFiles")
		userProfile := os.Getenv("USERPROFILE")
		paths := []string{
			filepath.Join(localAppData, "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
			filepath.Join(programFiles, "Antigravity IDE", "Antigravity IDE.exe"),
			filepath.Join(userProfile, "AppData", "Local", "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
		}
		for _, p := range paths {
			if p == "" {
				continue
			}
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	case "linux":
		paths := []string{
			"/usr/share/antigravity-ide/antigravity-ide",
			"/opt/Antigravity IDE/antigravity-ide",
		}
		home := os.Getenv("HOME")
		if home != "" {
			paths = append(paths, filepath.Join(home, ".local", "share", "applications", "antigravity-ide"))
		}
		for _, p := range paths {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

// ======================== asar 热补丁 ========================

// detectAntigravityHubPath 检测 Antigravity Hub 安装路径
// 优先级: 用户配置 > 注册表/Spotlight/.desktop > 硬编码路径
func detectAntigravityHubPath() string {
	// 1. 用户自定义路径
	cfg := LoadConfig()
	if cfg.HubPath != "" {
		if info, err := os.Stat(cfg.HubPath); err == nil {
			if !info.IsDir() {
				return filepath.Dir(cfg.HubPath)
			}
			return cfg.HubPath
		}
	}

	// 2. 智能检测
	switch runtime.GOOS {
	case "windows":
		// 搜索 "Antigravity" 但排除 "Antigravity IDE"
		if loc := registryFindInstallPath("Antigravity"); loc != "" {
			if strings.Contains(loc, "Antigravity IDE") {
				// 跳过 IDE 的条目
			} else if strings.HasSuffix(strings.ToLower(loc), ".exe") {
				return filepath.Dir(loc)
			} else {
				if _, err := os.Stat(loc); err == nil {
					return loc
				}
			}
		}
	case "darwin":
		if p := spotlightFindApp("Antigravity.app"); p != "" {
			return p
		}
	case "linux":
		if p := desktopFindApp("Antigravity"); p != "" {
			if !strings.Contains(p, "antigravity-ide") {
				return filepath.Dir(p)
			}
		}
	}

	// 3. 硬编码路径兜底
	switch runtime.GOOS {
	case "darwin":
		if _, err := os.Stat("/Applications/Antigravity.app"); err == nil {
			return "/Applications/Antigravity.app"
		}
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		programFiles := os.Getenv("ProgramFiles")
		paths := []string{
			filepath.Join(localAppData, "Programs", "Antigravity", "Antigravity.exe"),
			filepath.Join(programFiles, "Antigravity", "Antigravity.exe"),
		}
		for _, p := range paths {
			if p == "" {
				continue
			}
			if _, err := os.Stat(p); err == nil {
				return filepath.Dir(p)
			}
		}
	case "linux":
		paths := []string{
			"/opt/Antigravity/antigravity",
			"/usr/share/antigravity/antigravity",
		}
		for _, p := range paths {
			if _, err := os.Stat(p); err == nil {
				return filepath.Dir(p)
			}
		}
	}
	return ""
}

// getAsarPath 获取 asar 文件路径
func getAsarPath(hubPath string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(hubPath, "Contents", "Resources", "app.asar")
	case "windows", "linux":
		// Windows/Linux: hubPath 是 exe 所在目录，asar 在 resources/app.asar
		return filepath.Join(hubPath, "resources", "app.asar")
	default:
		return ""
	}
}

// asarHeader 表示 asar 文件头
type asarHeader struct {
	Files map[string]interface{} `json:"files"`
}

// readAsarJS 从 asar 中提取 dist/languageServer.js 内容及位置信息
func readAsarJS(asarData []byte) (jsContent string, headerPickleSize uint32, dataOffset uint64, absoluteOffset uint64, fileSize int, header *asarHeader, lsMap map[string]interface{}, err error) {
	if len(asarData) < 16 {
		err = fmt.Errorf("asar 文件太小")
		return
	}

	headerPickleSize = binary.LittleEndian.Uint32(asarData[4:8])
	headerStringSize := binary.LittleEndian.Uint32(asarData[12:16])

	headerStart := uint32(16)
	headerEnd := headerStart + headerStringSize
	if uint32(len(asarData)) < headerEnd {
		err = fmt.Errorf("asar header 超出文件范围")
		return
	}

	headerStr := string(asarData[headerStart:headerEnd])
	headerStr = strings.TrimRight(headerStr, "\x00")

	header = &asarHeader{}
	if err = json.Unmarshal([]byte(headerStr), header); err != nil {
		err = fmt.Errorf("解析 header JSON 失败: %w", err)
		return
	}

	distFiles, ok := header.Files["dist"]
	if !ok {
		err = fmt.Errorf("asar header 中找不到 dist 目录")
		return
	}
	distMap, ok := distFiles.(map[string]interface{})
	if !ok {
		err = fmt.Errorf("dist 不是目录")
		return
	}
	distSubFiles, ok := distMap["files"]
	if !ok {
		err = fmt.Errorf("dist 下没有 files")
		return
	}
	distSubMap, ok := distSubFiles.(map[string]interface{})
	if !ok {
		err = fmt.Errorf("dist/files 格式错误")
		return
	}
	lsEntry, ok := distSubMap["languageServer.js"]
	if !ok {
		err = fmt.Errorf("dist/languageServer.js 在 asar header 中找不到")
		return
	}
	lsMap, ok = lsEntry.(map[string]interface{})
	if !ok {
		err = fmt.Errorf("languageServer.js 条目格式错误")
		return
	}

	offsetStr, _ := lsMap["offset"].(string)
	sizeFloat, _ := lsMap["size"].(float64)
	if offsetStr == "" || sizeFloat == 0 {
		err = fmt.Errorf("languageServer.js offset/size 无效")
		return
	}

	var fileOffset uint64
	fmt.Sscanf(offsetStr, "%d", &fileOffset)
	fileSize = int(sizeFloat)

	dataOffset = uint64(8 + headerPickleSize)
	if dataOffset%4 != 0 {
		dataOffset += 4 - (dataOffset % 4)
	}

	absoluteOffset = dataOffset + fileOffset
	if uint64(len(asarData)) < absoluteOffset+uint64(fileSize) {
		err = fmt.Errorf("languageServer.js 超出 asar 文件范围")
		return
	}

	jsContent = string(asarData[absoluteOffset : absoluteOffset+uint64(fileSize)])
	return
}

// PatchAsar 补丁 Antigravity.app 的 app.asar
// 采用两种策略：
// 1. 替换 args 数组中的 --api_server_url / --cloud_code_endpoint URL
// 2. 注入/替换 env['CLOUD_CODE_URL'] 环境变量
func PatchAsar(proxyPort int) error {
	ideInjectMu.Lock()
	defer ideInjectMu.Unlock()

	hubPath := detectAntigravityHubPath()
	if hubPath == "" {
		return fmt.Errorf("未检测到 Antigravity.app")
	}

	asarPath := getAsarPath(hubPath)
	if asarPath == "" {
		return fmt.Errorf("无法确定 asar 路径")
	}

	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
	backupPath := asarPath + ".bak"

	asarData, err := os.ReadFile(asarPath)
	if err != nil {
		return fmt.Errorf("读取 asar 失败: %w", err)
	}

	jsContent, headerPickleSize, dataOffset, absoluteOffset, fileSize, header, lsMap, err := readAsarJS(asarData)
	if err != nil {
		return fmt.Errorf("解析 asar 失败: %w", err)
	}

	newJs := jsContent
	replaced := false

	// 策略 1: 替换所有可能的 URL（Google 原始 URL + timo 残留 URL + 其他代理 URL）
	// 使用正则匹配 http://127.0.0.1:XXXXX 格式的本地代理 URL
	localProxyRe := regexp.MustCompile(`http://127\.0\.0\.1:\d+`)

	knownURLs := []string{
		"https://cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.googleapis.com",
		"https://generativelanguage.googleapis.com",
	}

	for _, u := range knownURLs {
		if strings.Contains(newJs, u) {
			newJs = strings.ReplaceAll(newJs, u, proxyURL)
			replaced = true
		}
	}

	// 替换 args 中的 --api_server_url 和 --cloud_code_endpoint 后面的 URL
	// 匹配模式：'--api_server_url',\n            'http://127.0.0.1:XXXXX',
	argURLRe := regexp.MustCompile(`('--(?:api_server_url|cloud_code_endpoint)',\s*')([^']+)(')`)
	if argURLRe.MatchString(newJs) {
		newJs = argURLRe.ReplaceAllString(newJs, "${1}"+proxyURL+"${3}")
		replaced = true
	}

	// 替换 env['CLOUD_CODE_URL'] 和 env['UNLEASH_URL'] 的值
	envURLRe := regexp.MustCompile(`(env\['(?:CLOUD_CODE_URL|UNLEASH_URL)'\]\s*=\s*')([^']+)(')`)
	if envURLRe.MatchString(newJs) {
		newJs = envURLRe.ReplaceAllString(newJs, "${1}"+proxyURL+"${3}")
		replaced = true
	}

	// 如果没有找到 timo 注入的 env 行，我们需要自己注入
	if !strings.Contains(newJs, "env['CLOUD_CODE_URL']") {
		// 查找 env 初始化锚点: const env = { ...process.env
		anchor := "const env = { ...process.env"
		if idx := strings.Index(newJs, anchor); idx >= 0 {
			// 找到这一行的结尾（分号后）
			lineEnd := strings.Index(newJs[idx:], ";")
			if lineEnd >= 0 {
				insertPos := idx + lineEnd + 1
				injection := fmt.Sprintf("\n        // ── Endpoints redirected by CodeRelay ──\n        env['CLOUD_CODE_URL'] = '%s';\n        env['UNLEASH_URL'] = '%s';", proxyURL, proxyURL)
				newJs = newJs[:insertPos] + injection + newJs[insertPos:]
				replaced = true
			}
		}
	}

	// 替换任何残留的本地代理 URL（非我们的端口）
	if localProxyRe.MatchString(newJs) {
		matches := localProxyRe.FindAllString(newJs, -1)
		for _, m := range matches {
			if m != proxyURL {
				newJs = strings.ReplaceAll(newJs, m, proxyURL)
				replaced = true
			}
		}
	}

	if !replaced {
		return fmt.Errorf("在 languageServer.js 中未找到可替换的 URL 或注入点，桌面应用版本可能不兼容")
	}

	// 备份原 asar（仅在没有备份时才备份，避免覆盖干净备份）
	if _, statErr := os.Stat(backupPath); os.IsNotExist(statErr) {
		if err := copyFile(asarPath, backupPath); err != nil {
			return fmt.Errorf("备份 asar 失败: %w", err)
		}
		Log("[ide-inject] 已备份 app.asar -> app.asar.bak")
	} else {
		Log("[ide-inject] app.asar.bak 已存在，跳过备份")
	}

	// 重建 asar
	newJsBytes := []byte(newJs)
	sizeDiff := len(newJsBytes) - fileSize

	lsMap["size"] = float64(len(newJsBytes))

	if sizeDiff != 0 {
		return rebuildAsarWithPatchedJS(asarData, header, headerPickleSize, dataOffset, absoluteOffset, uint64(fileSize), newJsBytes, asarPath)
	}

	// 大小相同，直接原地替换
	newAsar := make([]byte, len(asarData))
	copy(newAsar, asarData)
	copy(newAsar[absoluteOffset:], newJsBytes)

	tmpPath := asarPath + "_patch_tmp"
	if err := os.WriteFile(tmpPath, newAsar, 0644); err != nil {
		return fmt.Errorf("写入补丁 asar 失败: %w", err)
	}
	if err := os.Rename(tmpPath, asarPath); err != nil {
		return fmt.Errorf("替换 asar 失败: %w", err)
	}

	Log("[ide-inject] asar 补丁完成! URL 已替换为 %s", proxyURL)
	return nil
}

// rebuildAsarWithPatchedJS 当文件大小变化时重建 asar
func rebuildAsarWithPatchedJS(origAsar []byte, header *asarHeader, headerPickleSize uint32, dataOffset uint64, jsAbsOffset uint64, jsOrigSize uint64, newJsBytes []byte, outputPath string) error {
	sizeDiff := int64(len(newJsBytes)) - int64(jsOrigSize)

	updateOffsets(header.Files, int64(jsAbsOffset-dataOffset), sizeDiff)

	newHeaderJSON, err := json.Marshal(header)
	if err != nil {
		return fmt.Errorf("序列化 header 失败: %w", err)
	}

	newHeaderSize := uint32(len(newHeaderJSON))
	innerPickleSize := 4 + newHeaderSize
	if innerPickleSize%4 != 0 {
		innerPickleSize += 4 - (innerPickleSize % 4)
	}
	outerPickleSize := 4 + innerPickleSize

	newHeaderArea := make([]byte, 8+outerPickleSize)
	binary.LittleEndian.PutUint32(newHeaderArea[0:4], 4)
	binary.LittleEndian.PutUint32(newHeaderArea[4:8], outerPickleSize)
	binary.LittleEndian.PutUint32(newHeaderArea[8:12], innerPickleSize)
	binary.LittleEndian.PutUint32(newHeaderArea[12:16], newHeaderSize)
	copy(newHeaderArea[16:], newHeaderJSON)

	origDataStart := dataOffset
	jsRelOffset := jsAbsOffset - dataOffset

	beforeJs := origAsar[origDataStart : origDataStart+jsRelOffset]
	afterJsStart := origDataStart + jsRelOffset + jsOrigSize
	afterJs := origAsar[afterJsStart:]

	totalSize := len(newHeaderArea) + len(beforeJs) + len(newJsBytes) + len(afterJs)
	newAsar := make([]byte, 0, totalSize)
	newAsar = append(newAsar, newHeaderArea...)
	newAsar = append(newAsar, beforeJs...)
	newAsar = append(newAsar, newJsBytes...)
	newAsar = append(newAsar, afterJs...)

	origSize := len(origAsar)
	newSize := len(newAsar)
	diffPercent := float64(newSize-origSize) / float64(origSize) * 100
	if diffPercent > 50 || diffPercent < -50 {
		Log("[ide-inject] 警告: 补丁后 asar 大小变化异常 (原=%dKB, 新=%dKB, 差=%.1f%%)", origSize/1024, newSize/1024, diffPercent)
	}

	tmpPath := outputPath + "_patch_tmp"
	if err := os.WriteFile(tmpPath, newAsar, 0644); err != nil {
		return fmt.Errorf("写入补丁 asar 失败: %w", err)
	}
	if err := os.Rename(tmpPath, outputPath); err != nil {
		return fmt.Errorf("替换 asar 失败: %w", err)
	}

	Log("[ide-inject] asar 重建完成 (orig=%dKB new=%dKB)", origSize/1024, newSize/1024)
	return nil
}

// updateOffsets 递归更新 header 中受影响文件的 offset
func updateOffsets(files map[string]interface{}, changedOffset int64, sizeDiff int64) {
	for _, v := range files {
		entry, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		if subFiles, ok := entry["files"]; ok {
			if subMap, ok := subFiles.(map[string]interface{}); ok {
				updateOffsets(subMap, changedOffset, sizeDiff)
			}
			continue
		}
		offsetStr, ok := entry["offset"].(string)
		if !ok {
			continue
		}
		var offset int64
		fmt.Sscanf(offsetStr, "%d", &offset)
		if offset > changedOffset {
			entry["offset"] = fmt.Sprintf("%d", offset+sizeDiff)
		}
	}
}

// RestoreAsar 恢复 asar 补丁
func RestoreAsar() error {
	ideInjectMu.Lock()
	defer ideInjectMu.Unlock()

	hubPath := detectAntigravityHubPath()
	if hubPath == "" {
		return fmt.Errorf("未检测到 Antigravity.app")
	}

	asarPath := getAsarPath(hubPath)
	backupPath := asarPath + ".bak"

	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		return fmt.Errorf("未找到 asar 备份文件")
	}

	if err := copyFile(backupPath, asarPath); err != nil {
		return fmt.Errorf("恢复 asar 失败: %w", err)
	}

	// 恢复后删除备份文件
	_ = os.Remove(backupPath)

	Log("[ide-inject] 已从备份恢复 app.asar")
	return nil
}

// checkAsarPatchedForUs 检查 asar 是否已被我们补丁（检查 JS 中是否包含我们的代理 URL）
func checkAsarPatchedForUs(asarPath string, proxyURL string) bool {
	if asarPath == "" {
		return false
	}
	asarData, err := os.ReadFile(asarPath)
	if err != nil {
		return false
	}
	jsContent, _, _, _, _, _, _, err := readAsarJS(asarData)
	if err != nil {
		return false
	}
	return strings.Contains(jsContent, proxyURL)
}

// copyFile 复制文件
func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}

// ======================== 应用重启 ========================

// lsProcessInfo 表示一个 language_server 进程的信息
type lsProcessInfo struct {
	PID     string
	CmdLine string
}

// queryLanguageServerProcesses 查询所有 language_server 进程，返回逐进程的 PID+CommandLine
func queryLanguageServerProcesses() []lsProcessInfo {
	var results []lsProcessInfo

	switch runtime.GOOS {
	case "windows":
		// 使用 wmic 替代 PowerShell（避免 CLR 冷启动弹窗和 ~500ms 延迟）
		out, err := hideCmd("wmic", "process", "where",
			`name like 'language_server%'`,
			"get", "ProcessId,CommandLine", "/format:list",
		).Output()
		if err != nil || len(strings.TrimSpace(string(out))) == 0 {
			return results
		}
		var curPID, curCmd string
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "CommandLine=") {
				curCmd = strings.TrimPrefix(line, "CommandLine=")
			} else if strings.HasPrefix(line, "ProcessId=") {
				curPID = strings.TrimPrefix(line, "ProcessId=")
				if curPID != "" {
					results = append(results, lsProcessInfo{PID: curPID, CmdLine: curCmd})
				}
				curPID = ""
				curCmd = ""
			}
		}

	case "darwin":
		out, err := hideCmd("bash", "-c",
			"ps -eo pid,command | grep 'language_server_darwin' | grep -v grep",
		).Output()
		if err != nil {
			return results
		}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			fields := strings.SplitN(line, " ", 2)
			if len(fields) == 2 {
				results = append(results, lsProcessInfo{PID: fields[0], CmdLine: fields[1]})
			}
		}

	case "linux":
		out, err := hideCmd("bash", "-c",
			"ps -eo pid,command | grep 'language_server_linux' | grep -v grep",
		).Output()
		if err != nil {
			return results
		}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			fields := strings.SplitN(line, " ", 2)
			if len(fields) == 2 {
				results = append(results, lsProcessInfo{PID: fields[0], CmdLine: fields[1]})
			}
		}
	}

	return results
}

// IsLSProxyApplied 检查所有正在运行的 language_server 是否都已连接到代理端口
// 类似 timo 的 is_ls_proxy_applied 字段，前端可用于轮询确认注入是否真正生效
func IsLSProxyApplied(proxyPort int) bool {
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
	processes := queryLanguageServerProcesses()

	if len(processes) == 0 {
		// 没有 LS 进程运行，视为未生效
		return false
	}

	for _, p := range processes {
		if !strings.Contains(p.CmdLine, proxyURL) {
			return false
		}
	}
	return true
}

// RestartLanguageServerIfNeeded 逐进程检查 language_server 是否已指向代理
// 只杀未连接代理的进程，保留已接管的进程（修复多 LS 场景下的 bug）
func RestartLanguageServerIfNeeded(proxyPort int) {
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
	processes := queryLanguageServerProcesses()

	if len(processes) == 0 {
		Log("[ide-inject] language_server 未运行，跳过")
		return
	}

	Log("[ide-inject] 发现 %d 个 language_server 进程", len(processes))

	killedCount := 0
	skippedCount := 0

	for _, p := range processes {
		if strings.Contains(p.CmdLine, proxyURL) {
			Log("[ide-inject] PID %s 已连接代理 %s，保留", p.PID, proxyURL)
			skippedCount++
			continue
		}

		// 未连接代理 → 精确杀掉该 PID
		Log("[ide-inject] PID %s 未连接代理，正在终止...", p.PID)
		switch runtime.GOOS {
		case "windows":
			_ = hideCmd("taskkill", "/PID", p.PID, "/F").Run()
		default:
			_ = hideCmd("kill", "-9", p.PID).Run()
		}
		killedCount++
	}

	if killedCount > 0 {
		Log("[ide-inject] 已终止 %d 个未接管的 language_server，保留 %d 个已接管的", killedCount, skippedCount)
	} else {
		Log("[ide-inject] 所有 %d 个 language_server 均已连接代理，无需重启", skippedCount)
	}
}

// KillAndRestartIDE 杀死并重启 Antigravity IDE
func KillAndRestartIDE() error {
	idePath := detectAntigravityIDEPath()
	if idePath == "" {
		return fmt.Errorf("未检测到 IDE 安装路径")
	}

	Log("[ide-inject] 正在关闭 Antigravity IDE...")

	switch runtime.GOOS {
	case "darwin":
		// 使用 SIGTERM 而非 osascript，避免 macOS 自动化权限问题
		_ = hideCmd("pkill", "-TERM", "-f", "Antigravity IDE.app/Contents/MacOS").Run()
		if !waitForProcessExit(IsIDERunning, 5*time.Second) {
			_ = hideCmd("pkill", "-9", "-f", "Antigravity IDE.app/Contents/MacOS").Run()
			waitForProcessExit(IsIDERunning, 2*time.Second)
		}
	case "windows":
		_ = hideCmd("taskkill", "/IM", "Antigravity IDE.exe", "/F").Run()
		_ = hideCmd("taskkill", "/IM", "Antigravity.exe", "/F").Run()
		time.Sleep(2 * time.Second)
	case "linux":
		_ = hideCmd("pkill", "-f", "antigravity-ide").Run()
		time.Sleep(2 * time.Second)
	}

	Log("[ide-inject] 正在重启 Antigravity IDE...")
	return launchApp(idePath)
}

// ForceRestartIDE 完整重启 IDE（杀 LS + IDE 主进程 + 等待端口释放 + 重启）
// 用于解决 extension host 缓存旧 LS 端口导致 ECONNREFUSED 的问题
// 与 Timo 的 taskkill /IM 策略一致
func ForceRestartIDE() error {
	idePath := detectAntigravityIDEPath()
	if idePath == "" {
		return fmt.Errorf("未检测到 IDE 安装路径")
	}

	Log("[ide-inject] [FORCE] 开始完整重启 IDE（解决 extension host 端口缓存）")

	// 1. 先杀所有 language_server
	switch runtime.GOOS {
	case "windows":
		_ = hideCmd("taskkill", "/IM", "language_server_windows_x64.exe", "/F").Run()
	case "darwin":
		_ = hideCmd("pkill", "-f", "language_server").Run()
	case "linux":
		_ = hideCmd("pkill", "-f", "language_server").Run()
	}
	time.Sleep(1 * time.Second)

	// 2. 优雅关闭 IDE 主进程
	switch runtime.GOOS {
	case "windows":
		_ = hideCmd("taskkill", "/IM", "Antigravity IDE.exe").Run() // 不带 /F = WM_CLOSE
		Log("[ide-inject] [FORCE] 已发送优雅关闭请求")
		if !waitForProcessExit(IsIDERunning, 5*time.Second) {
			_ = hideCmd("taskkill", "/IM", "Antigravity IDE.exe", "/F").Run()
			_ = hideCmd("taskkill", "/IM", "Antigravity.exe", "/F").Run()
			Log("[ide-inject] [FORCE] IDE 未响应，已强杀")
			waitForProcessExit(IsIDERunning, 2*time.Second)
		}
	case "darwin":
		// 使用 SIGTERM 而非 osascript，避免 macOS 自动化权限问题
		_ = hideCmd("pkill", "-TERM", "-f", "Antigravity IDE.app/Contents/MacOS").Run()
		Log("[ide-inject] [FORCE] 已发送 SIGTERM")
		if !waitForProcessExit(IsIDERunning, 5*time.Second) {
			_ = hideCmd("pkill", "-9", "-f", "Antigravity IDE.app/Contents/MacOS").Run()
			Log("[ide-inject] [FORCE] IDE 未响应 SIGTERM，已发送 SIGKILL")
			waitForProcessExit(IsIDERunning, 2*time.Second)
		}
	case "linux":
		_ = hideCmd("pkill", "-f", "antigravity-ide").Run()
		time.Sleep(2 * time.Second)
	}

	// 3. 确认全部退出
	if IsIDERunning() {
		Log("[ide-inject] [FORCE] 警告：IDE 仍在运行")
	}

	// 4. 重启 IDE
	Log("[ide-inject] [FORCE] 正在重启 Antigravity IDE...")
	if err := launchApp(idePath); err != nil {
		return fmt.Errorf("重启 IDE 失败: %w", err)
	}

	Log("[ide-inject] [FORCE] IDE 已重启，等待 LS 自动拉起...")
	return nil
}

// waitForProcessExit 轮询等待进程退出，避免固定 time.Sleep 阻塞 Wails 主线程
// check 返回 true 表示进程仍在运行，maxWait 为最长等待时间
func waitForProcessExit(check func() bool, maxWait time.Duration) bool {
	interval := 200 * time.Millisecond
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) {
		time.Sleep(interval)
		if !check() {
			return true // 进程已退出
		}
	}
	return false // 超时，进程仍在运行
}

// killProcessesByPattern 通过 pgrep 查找进程 PID，然后用 kill 逐个终止
// 比 pkill 更可靠，且能记录每个 PID 的终止情况
func killProcessesByPattern(pattern string, signal string) int {
	out, err := hideCmd("pgrep", "-f", pattern).Output()
	if err != nil || len(strings.TrimSpace(string(out))) == 0 {
		Log("[ide-inject] pgrep '%s' 未找到匹配进程", pattern)
		return 0
	}

	pids := strings.Fields(strings.TrimSpace(string(out)))
	Log("[ide-inject] 找到 %d 个匹配进程 (pattern='%s'): PIDs=%v", len(pids), pattern, pids)

	killedCount := 0
	for _, pid := range pids {
		pid = strings.TrimSpace(pid)
		if pid == "" {
			continue
		}
		err := hideCmd("kill", signal, pid).Run()
		if err != nil {
			Log("[ide-inject] kill %s %s 失败: %v", signal, pid, err)
		} else {
			Log("[ide-inject] kill %s %s 成功", signal, pid)
			killedCount++
		}
	}
	return killedCount
}

// killHubForPatch 关闭 Hub 以释放 app.asar 文件锁（用于 PatchAsar 之前）
// 与 KillAndRestartHub 不同，此函数不重启 Hub，只负责关闭并等待进程完全退出
func killHubForPatch() {
	Log("[ide-inject] [PATCH] 正在关闭 Hub 以释放 app.asar 文件锁...")

	switch runtime.GOOS {
	case "darwin":
		// 使用 pgrep+kill 而非 osascript (Apple Events)，避免 macOS 自动化权限问题导致 Wails 应用崩溃
		killProcessesByPattern("Antigravity.app/Contents", "-TERM")
		Log("[ide-inject] [PATCH] 已发送 SIGTERM")
		// 轮询等待所有进程退出（最多 5 秒）
		if !waitForProcessExit(IsHubRunning, 5*time.Second) {
			// 仍有进程存活，SIGKILL 强杀
			killProcessesByPattern("Antigravity.app/Contents", "-9")
			Log("[ide-inject] [PATCH] Hub 未响应 SIGTERM，已发送 SIGKILL")
			waitForProcessExit(IsHubRunning, 2*time.Second)
		}
	case "windows":
		// 优雅关闭
		_ = hideCmd("taskkill", "/IM", "Antigravity.exe").Run()
		if !waitForProcessExit(IsHubRunning, 5*time.Second) {
			_ = hideCmd("taskkill", "/IM", "Antigravity.exe", "/F").Run()
			Log("[ide-inject] [PATCH] Hub 未响应优雅关闭，已强杀")
			waitForProcessExit(IsHubRunning, 2*time.Second)
		}
	case "linux":
		_ = hideCmd("pkill", "-TERM", "-f", "antigravity").Run()
		waitForProcessExit(IsHubRunning, 3*time.Second)
	}

	// 最终确认
	if IsHubRunning() {
		Log("[ide-inject] [PATCH] 警告：Hub 仍在运行，app.asar 可能仍被锁定")
	} else {
		Log("[ide-inject] [PATCH] Hub 已完全退出，文件锁已释放")
	}
}

// KillAndRestartHub 杀死并重启 Antigravity Hub
func KillAndRestartHub() error {
	hubPath := detectAntigravityHubPath()
	if hubPath == "" {
		return fmt.Errorf("未检测到 Antigravity Hub 安装路径")
	}

	Log("[ide-inject] 正在关闭 Antigravity Hub...")

	switch runtime.GOOS {
	case "darwin":
		// 使用 pgrep+kill 而非 osascript，避免 macOS 自动化权限问题
		killProcessesByPattern("Antigravity.app/Contents", "-TERM")
		Log("[ide-inject] 已发送 SIGTERM")
		if !waitForProcessExit(IsHubRunning, 5*time.Second) {
			killProcessesByPattern("Antigravity.app/Contents", "-9")
			Log("[ide-inject] Hub 未响应 SIGTERM，已发送 SIGKILL")
			waitForProcessExit(IsHubRunning, 2*time.Second)
		}
	case "windows":
		// 先优雅关闭（WM_CLOSE），让应用保存数据（与 timo 行为一致）
		_ = hideCmd("taskkill", "/IM", "Antigravity.exe").Run() // 不带 /F = WM_CLOSE
		Log("[ide-inject] 已发送优雅关闭请求 (WM_CLOSE)")
		if !waitForProcessExit(IsHubRunning, 5*time.Second) {
			_ = hideCmd("taskkill", "/IM", "Antigravity.exe", "/F").Run()
			Log("[ide-inject] Hub 未响应优雅关闭，已强杀")
			waitForProcessExit(IsHubRunning, 2*time.Second)
		}
	case "linux":
		_ = hideCmd("pkill", "-TERM", "-f", "antigravity").Run()
		waitForProcessExit(IsHubRunning, 3*time.Second)
	}

	Log("[ide-inject] 正在重启 Antigravity Hub...")
	return launchApp(hubPath)
}

// IsIDERunning 检测 IDE 是否正在运行
func IsIDERunning() bool {
	switch runtime.GOOS {
	case "darwin":
		out, err := hideCmd("pgrep", "-f", "Antigravity IDE").Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	case "windows":
		out, err := hideCmd("tasklist", "/FI", "IMAGENAME eq Antigravity IDE.exe", "/NH").Output()
		if err != nil {
			// 也检查 Antigravity.exe
			out2, err2 := hideCmd("tasklist", "/FI", "IMAGENAME eq Antigravity.exe", "/NH").Output()
			if err2 != nil {
				return false
			}
			return !strings.Contains(string(out2), "No tasks")
		}
		return !strings.Contains(string(out), "No tasks")
	case "linux":
		out, err := hideCmd("pgrep", "-f", "antigravity-ide").Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	default:
		return false
	}
}

// IsHubRunning 检测 Hub 是否正在运行
func IsHubRunning() bool {
	switch runtime.GOOS {
	case "darwin":
		out, err := hideCmd("pgrep", "-f", "Antigravity.app/Contents").Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	case "windows":
		out, err := hideCmd("tasklist", "/FI", "IMAGENAME eq Antigravity.exe", "/NH").Output()
		if err != nil {
			return false
		}
		return !strings.Contains(string(out), "No tasks")
	case "linux":
		out, err := hideCmd("pgrep", "-f", "antigravity$").Output()
		if err != nil {
			return false
		}
		return strings.TrimSpace(string(out)) != ""
	default:
		return false
	}
}

// LaunchIDE 启动 IDE（不杀进程，仅打开）
func LaunchIDE() error {
	idePath := detectAntigravityIDEPath()
	if idePath == "" {
		return fmt.Errorf("未检测到 IDE 安装路径")
	}
	Log("[ide-inject] 正在启动 Antigravity IDE...")
	return launchApp(idePath)
}

// LaunchHub 启动 Hub（不杀进程，仅打开）
func LaunchHub() error {
	hubPath := detectAntigravityHubPath()
	if hubPath == "" {
		return fmt.Errorf("未检测到 Hub 安装路径")
	}
	Log("[ide-inject] 正在启动 Antigravity Hub...")
	return launchApp(hubPath)
}

// launchApp 跨平台启动应用
func launchApp(appPath string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-a", appPath)
	case "windows":
		// Windows: 如果是 exe 直接执行，如果是目录找 exe
		if strings.HasSuffix(strings.ToLower(appPath), ".exe") {
			cmd = exec.Command(appPath)
		} else {
			// 尝试在目录下找 exe
			entries, _ := os.ReadDir(appPath)
			for _, e := range entries {
				if strings.HasSuffix(strings.ToLower(e.Name()), ".exe") {
					cmd = exec.Command(filepath.Join(appPath, e.Name()))
					break
				}
			}
			if cmd == nil {
				return fmt.Errorf("在 %s 中未找到可执行文件", appPath)
			}
		}
	case "linux":
		cmd = exec.Command(appPath)
	default:
		return fmt.Errorf("不支持的操作系统: %s", runtime.GOOS)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动失败: %w", err)
	}
	Log("[ide-inject] 应用已启动: %s", appPath)
	return nil
}
