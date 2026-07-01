package quota

// antigravity 的额度不在 Google OAuth 里,而在 Google Cloud Code Companion API。
// 照搬 cockpit crates/cockpit-core/src/modules/quota.rs::fetch_quota_with_context +
// 前端 src/presentation/platformAccountPresentation.ts::getAntigravityQuotaDisplayItems 的流程:
//
//  1. v1internal:loadCodeAssist        → 确认/领取 cloudaicompanionProject + 订阅档(tier)。
//     个人 gmail 号首次无 project 时,再走 v1internal:onboardUser 领一个。
//  2. v1internal:fetchAvailableModels  → models{ 模型名: quotaInfo{remainingFraction,resetTime} }。
//  3. v1internal:retrieveUserQuotaSummary → groups[].buckets[]:bucketId=gemini-5h/gemini-weekly/
//     3p-5h/3p-weekly,remainingFraction(0..1)+resetTime。
//
// 两处合并成一个「模型/桶」列表,再按 cockpit 的回退链挑出 4 个展示项:
//   Gemini 5h / Gemini 周 / Claude 5h / Claude 周(缺则不展示)。写入 Result.Buckets(多桶),
//   并把 gemini-5h/gemini-weekly 兼容回填 Hourly/Weekly。缺桶 = 未知(Known=false),keep-prior,
//   绝不伪造满血(见 codex-quota-window-unknown-parity)。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"bcai-wails/internal/local/account"
)

// Logf 可选诊断日志钩子(main 包用 quota.Logf = Log 接线;nil 时静默)。
var Logf func(format string, args ...any)

func logf(format string, args ...any) {
	if Logf != nil {
		Logf(format, args...)
	}
}

const (
	cloudCodeDailyBaseURL = "https://daily-cloudcode-pa.googleapis.com"
	cloudCodeProdBaseURL  = "https://cloudcode-pa.googleapis.com"

	loadCodeAssistPath = "v1internal:loadCodeAssist"
	onboardUserPath    = "v1internal:onboardUser"
	fetchModelsPath    = "v1internal:fetchAvailableModels"
	quotaSummaryPath   = "v1internal:retrieveUserQuotaSummary"

	// 与 cockpit DEFAULT_CLOUD_CODE_IDE_VERSION / google-api-nodejs-client 版本对齐。
	cloudCodeIDEVersion   = "1.20.5"
	googleAPINodeJSClient = "10.3.0"

	onboardPollDelay = 500 * time.Millisecond
	onboardMaxPolls  = 12
)

// FetchQuota 拉一次 antigravity 额度(照搬 cockpit fetch_quota_with_context 的 Cloud Code 流程)。
// 会就地回填 acc.ProjectID(领到/确认的 project),refreshOne 随后 Update 持久化,下轮免重复 onboard。
func (c *AntigravityFetcher) FetchQuota(acc *account.Account) (Result, error) {
	base := c.cloudCodeBaseURL(acc)

	// 1) loadCodeAssist:确认 project + 订阅档;缺 project 再 onboardUser 领一个。
	projectID, tier, err := c.loadCodeAssist(base, acc)
	if err != nil {
		return Result{}, err
	}
	if projectID != "" && projectID != acc.ProjectID {
		acc.ProjectID = projectID
	}
	effProject := strings.TrimSpace(acc.ProjectID)
	if effProject == "" {
		return Result{}, fmt.Errorf("未能确定 Cloud Code 项目(缺 project_id)")
	}

	// 2) fetchAvailableModels(主)+ retrieveUserQuotaSummary(尽力)→ 合并模型/桶列表。
	models, err := c.fetchAvailableModels(base, acc.AccessToken, effProject)
	if err != nil {
		return Result{}, err
	}
	if buckets, serrr := c.quotaSummaryModels(base, acc.AccessToken, effProject); serrr == nil {
		models = append(models, buckets...)
	} else {
		logf("[antigravity-quota] %s summary 失败(忽略,仅用 models): %v", acc.Email, serrr)
	}

	// 3) 按 cockpit 回退链挑 4 个展示项。
	plan := normalizeGeminiPlan(tier)
	res := buildAntigravityResult(models, plan == "FREE")
	if plan != "" {
		res.PlanType = plan
	}
	logf("[antigravity-quota] %s project=%s tier=%q models=%d buckets=%d", acc.Email, effProject, tier, len(models), len(res.Buckets))
	if len(res.Buckets) == 0 {
		return Result{}, fmt.Errorf("上游未返回额度桶(fetchAvailableModels+summary 皆空)")
	}
	return res, nil
}

// agModel 是「模型/桶」的归一项(fetchAvailableModels 的模型 + summary 的桶共用)。
type agModel struct {
	name    string // 模型名 或 bucketId(gemini-5h 等)
	percent int    // 剩余 0..100
	resetAt int64  // 下次重置 unix ms(0=未知)
}

// buildAntigravityResult 照搬 cockpit getAntigravityQuotaDisplayItems:回退链挑
// Gemini 5h/周 + Claude 5h/周,应用 free/非 free 的 reset 调整,产出 Result.Buckets +
// 兼容回填 Hourly/Weekly(gemini-5h/gemini-weekly)。
func buildAntigravityResult(models []agModel, isFree bool) Result {
	g5, gw := pickGemini5h(models), pickGeminiWeekly(models)
	c5, cw := pickClaude5h(models), pickClaudeWeekly(models)

	var res Result
	add := func(key, label string, pct int, reset int64) {
		res.Buckets = append(res.Buckets, account.QuotaBucket{Key: key, Label: label, Percent: pct, ResetAt: reset})
	}

	if g5 != nil {
		pct, reset := g5.percent, g5.resetAt
		if isFree {
			// free:5h 无 reset 时借用周 reset(照搬 cockpit)。
			if reset == 0 && gw != nil {
				reset = gw.resetAt
			}
		} else if reset > 0 && float64(reset-nowMs())/3600000.0 > 5 {
			// 非 free:reset 超过 5h(周限额在压 5h)→ 显示满血、清 reset。
			pct, reset = 100, 0
		}
		add("gemini-5h", "Gemini · 5 小时", pct, reset)
		res.HourlyPercent, res.HourlyResetAt, res.HourlyKnown = pct, reset, true
	}
	if gw != nil {
		add("gemini-weekly", "Gemini · 本周", gw.percent, gw.resetAt)
		res.WeeklyPercent, res.WeeklyResetAt, res.WeeklyKnown = gw.percent, gw.resetAt, true
	}
	if c5 != nil {
		reset := c5.resetAt
		if isFree && reset == 0 && cw != nil {
			reset = cw.resetAt
		}
		add("3p-5h", "Claude · 5 小时", c5.percent, reset)
	}
	if cw != nil {
		add("3p-weekly", "Claude · 本周", cw.percent, cw.resetAt)
	}
	return res
}

// cloudCodeBaseURL 与 cockpit resolve_cloud_code_base_url 对齐:override > gcpTos(prod) > daily。
func (c *AntigravityFetcher) cloudCodeBaseURL(acc *account.Account) string {
	if b := strings.TrimSpace(c.ep.CloudCodeBaseURL); b != "" {
		return b
	}
	if acc.IsGCPTos {
		return cloudCodeProdBaseURL
	}
	return cloudCodeDailyBaseURL
}

// ── loadCodeAssist / onboardUser(解析 project + tier) ──

type cloudCodeTier struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type allowedTier struct {
	ID        string `json:"id"`
	IsDefault bool   `json:"isDefault"`
}

type loadCodeAssistResp struct {
	Project      json.RawMessage `json:"cloudaicompanionProject"`
	CurrentTier  *cloudCodeTier  `json:"currentTier"`
	PaidTier     *cloudCodeTier  `json:"paidTier"`
	AllowedTiers []allowedTier   `json:"allowedTiers"`
}

type onboardResp struct {
	Name     string `json:"name"`
	Done     bool   `json:"done"`
	Response struct {
		Project json.RawMessage `json:"cloudaicompanionProject"`
	} `json:"response"`
}

func (c *AntigravityFetcher) loadCodeAssist(base string, acc *account.Account) (projectID, tier string, err error) {
	preferred := strings.TrimSpace(acc.ProjectID)
	payload := map[string]any{
		"metadata": cloudCodeMetadata(preferred),
		"mode":     "FULL_ELIGIBILITY_CHECK",
	}
	if preferred != "" {
		payload["cloudaicompanionProject"] = preferred
	}

	var resp loadCodeAssistResp
	if err := c.call(http.MethodPost, base+"/"+loadCodeAssistPath, acc.AccessToken, loadCodeAssistUA(), payload, &resp); err != nil {
		return "", "", err
	}
	// tier 选取对齐 cockpit selected_tier_id:paidTier.id → currentTier.id。
	// name 作为更友好的档名兜底(cockpit selected_tier_name)。
	tier = firstNonEmpty(tierName(resp.PaidTier), tierName(resp.CurrentTier), tierID(resp.PaidTier), tierID(resp.CurrentTier))
	logf("[antigravity-quota] %s loadCodeAssist paidTier.id=%q paidTier.name=%q currentTier.id=%q currentTier.name=%q allowed=%d",
		acc.Email, tierID(resp.PaidTier), tierName(resp.PaidTier), tierID(resp.CurrentTier), tierName(resp.CurrentTier), len(resp.AllowedTiers))

	if pid := extractProjectID(resp.Project); pid != "" {
		return pid, tier, nil
	}

	// 无 project(个人 gmail 首次)→ onboardUser 领一个。
	tierIDForOnboard := firstNonEmpty(pickOnboardTier(resp.AllowedTiers), tier)
	if tierIDForOnboard == "" {
		// 无 tier 可 onboard:退回既有 acc.ProjectID(可能为空,由 quotaSummary 报错)。
		return "", tier, nil
	}
	pid, err := c.onboardUser(base, acc.AccessToken, tierIDForOnboard, preferred)
	if err != nil {
		return "", tier, err
	}
	return pid, tier, nil
}

func (c *AntigravityFetcher) onboardUser(base, token, tierID, projectHint string) (string, error) {
	hint := strings.TrimSpace(projectHint)
	payload := map[string]any{
		"tierId":   tierID,
		"metadata": cloudCodeMetadata(hint),
	}
	if hint != "" {
		payload["cloudaicompanionProject"] = hint
	}

	var resp onboardResp
	if err := c.call(http.MethodPost, base+"/"+onboardUserPath, token, loadCodeAssistUA(), payload, &resp); err != nil {
		return "", err
	}

	for i := 0; i < onboardMaxPolls; i++ {
		if resp.Done {
			return extractProjectID(resp.Response.Project), nil
		}
		name := strings.TrimSpace(resp.Name)
		if name == "" {
			return "", fmt.Errorf("onboardUser 未完成但缺少 operation name")
		}
		time.Sleep(onboardPollDelay)
		resp = onboardResp{}
		if err := c.call(http.MethodGet, base+"/v1internal/"+name, token, loadCodeAssistUA(), nil, &resp); err != nil {
			return "", err
		}
	}
	return "", fmt.Errorf("onboardUser 轮询超时")
}

// ── fetchAvailableModels(per-model quotaInfo)──

type availModelsResp struct {
	Models map[string]struct {
		QuotaInfo *struct {
			RemainingFraction *float64        `json:"remainingFraction"`
			ResetTime         json.RawMessage `json:"resetTime"`
		} `json:"quotaInfo"`
	} `json:"models"`
}

// fetchAvailableModels 取每个 gemini/claude 模型的 quotaInfo(剩余分数 + reset)。
// 照搬 cockpit build_quota_data_from_response:仅含名字带 gemini/claude 的模型;
// 有 quotaInfo 即收(缺 remainingFraction 记 0),供回退链兜底 5h/周。
func (c *AntigravityFetcher) fetchAvailableModels(base, token, project string) ([]agModel, error) {
	var resp availModelsResp
	if err := c.call(http.MethodPost, base+"/"+fetchModelsPath, token, cloudCodeUA(), map[string]any{"project": project}, &resp); err != nil {
		return nil, err
	}
	var out []agModel
	for name, m := range resp.Models {
		l := strings.ToLower(name)
		if !strings.Contains(l, "gemini") && !strings.Contains(l, "claude") {
			continue
		}
		if m.QuotaInfo == nil {
			continue
		}
		pct := 0
		if m.QuotaInfo.RemainingFraction != nil {
			pct = fractionToPercent(*m.QuotaInfo.RemainingFraction)
		}
		out = append(out, agModel{name: name, percent: pct, resetAt: parseResetMs(m.QuotaInfo.ResetTime)})
	}
	return out, nil
}

// ── retrieveUserQuotaSummary(桶:gemini-5h/gemini-weekly/3p-5h/3p-weekly)──

type quotaBucket struct {
	BucketID          string          `json:"bucketId"`
	RemainingFraction *float64        `json:"remainingFraction"`
	ResetTime         json.RawMessage `json:"resetTime"`
}

type quotaSummaryResp struct {
	Groups []struct {
		Buckets []quotaBucket `json:"buckets"`
	} `json:"groups"`
}

func (c *AntigravityFetcher) quotaSummaryModels(base, token, project string) ([]agModel, error) {
	var resp quotaSummaryResp
	if err := c.call(http.MethodPost, base+"/"+quotaSummaryPath, token, cloudCodeUA(), map[string]any{"project": project}, &resp); err != nil {
		return nil, err
	}
	var out []agModel
	for _, g := range resp.Groups {
		for _, b := range g.Buckets {
			if b.RemainingFraction == nil || strings.TrimSpace(b.BucketID) == "" {
				continue
			}
			out = append(out, agModel{name: strings.TrimSpace(b.BucketID), percent: fractionToPercent(*b.RemainingFraction), resetAt: parseResetMs(b.ResetTime)})
		}
	}
	return out, nil
}

// ── 回退链选桶(照搬 cockpit getAntigravityQuotaDisplayItems 的 models.find 顺序)──

func findModel(models []agModel, pred func(string) bool) *agModel {
	for i := range models {
		if pred(models[i].name) {
			return &models[i]
		}
	}
	return nil
}

// exact 精确名匹配;allContains 要求(小写)全部包含;都用于回退链。
func exact(names ...string) func(string) bool {
	return func(n string) bool {
		for _, x := range names {
			if n == x {
				return true
			}
		}
		return false
	}
}

func allContains(subs ...string) func(string) bool {
	return func(n string) bool {
		l := strings.ToLower(n)
		for _, s := range subs {
			if !strings.Contains(l, s) {
				return false
			}
		}
		return true
	}
}

func pickGemini5h(m []agModel) *agModel {
	for _, pred := range []func(string) bool{
		exact("gemini-5h", "gemini:5h"),
		allContains("gemini", "pro", "high"),
		allContains("gemini", "high"),
		allContains("gemini", "flash"),
		func(n string) bool {
			l := strings.ToLower(n)
			return strings.Contains(l, "gemini") && !strings.Contains(l, "low")
		},
	} {
		if x := findModel(m, pred); x != nil {
			return x
		}
	}
	return nil
}

func pickGeminiWeekly(m []agModel) *agModel {
	for _, pred := range []func(string) bool{
		exact("gemini-weekly", "gemini:weekly"),
		allContains("gemini", "pro", "low"),
		allContains("gemini", "low"),
	} {
		if x := findModel(m, pred); x != nil {
			return x
		}
	}
	return nil
}

func pickClaude5h(m []agModel) *agModel {
	for _, pred := range []func(string) bool{
		exact("3p-5h", "claude:5h"),
		func(n string) bool {
			l := strings.ToLower(n)
			return strings.Contains(l, "claude") && (strings.Contains(l, "high") || !strings.Contains(l, "low"))
		},
		allContains("claude"),
	} {
		if x := findModel(m, pred); x != nil {
			return x
		}
	}
	return nil
}

func pickClaudeWeekly(m []agModel) *agModel {
	for _, pred := range []func(string) bool{
		exact("3p-weekly", "claude:weekly"),
		allContains("claude", "low"),
	} {
		if x := findModel(m, pred); x != nil {
			return x
		}
	}
	return nil
}

func nowMs() int64 { return time.Now().UnixMilli() }

// ── HTTP ──

// call 发一次 Cloud Code 请求(Bearer + UA);out 非 nil 时解析 JSON。
// 不手动设 Accept-Encoding:交给 Go transport 自动 gzip 并透明解压(手动设会拿到未解压字节)。
func (c *AntigravityFetcher) call(method, url, token, ua string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "*/*")

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("Cloud Code 请求失败: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Cloud Code %s 失败: status=%d body_len=%d", pathTail(url), resp.StatusCode, len(data))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("解析 Cloud Code 响应失败: %w", err)
		}
	}
	return nil
}

// ── UA / metadata(照搬 cockpit build_*_user_agent / build_cloud_code_metadata) ──

func cloudCodeUA() string {
	return fmt.Sprintf("antigravity/%s %s/%s", cloudCodeIDEVersion, uaOS(), uaArch())
}

func loadCodeAssistUA() string {
	return cloudCodeUA() + " google-api-nodejs-client/" + googleAPINodeJSClient
}

func uaOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "darwin"
	case "linux":
		return "linux"
	default:
		return "windows"
	}
}

func uaArch() string {
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "amd64"
}

func cloudCodePlatform() string {
	switch uaOS() + "-" + uaArch() {
	case "darwin-amd64":
		return "DARWIN_AMD64"
	case "darwin-arm64":
		return "DARWIN_ARM64"
	case "linux-amd64":
		return "LINUX_AMD64"
	case "linux-arm64":
		return "LINUX_ARM64"
	case "windows-amd64":
		return "WINDOWS_AMD64"
	default:
		return "PLATFORM_UNSPECIFIED"
	}
}

func cloudCodeMetadata(project string) map[string]any {
	m := map[string]any{
		"ideName":       "antigravity",
		"ideType":       "ANTIGRAVITY",
		"ideVersion":    cloudCodeIDEVersion,
		"pluginVersion": "unknown",
		"platform":      cloudCodePlatform(),
		"updateChannel": "stable",
		"pluginType":    "GEMINI",
	}
	if p := strings.TrimSpace(project); p != "" {
		m["duetProject"] = p
	}
	return m
}

// ── 解析辅助 ──

// fractionToPercent 照搬 cockpit parse_gemini_remaining_percent:round(f*100) clamp 0..100。
func fractionToPercent(f float64) int {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	p := int(math.Round(f * 100))
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// parseResetMs 照搬 cockpit parse_timestamp_like:RFC3339 / 数字秒 / 数字毫秒 / {seconds}。返回 unix ms(0=未知)。
func parseResetMs(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0
	}
	sec := timestampLikeSeconds(v)
	if sec <= 0 {
		return 0
	}
	return sec * 1000
}

func timestampLikeSeconds(v any) int64 {
	switch t := v.(type) {
	case float64:
		return normalizeTsSeconds(t)
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			return normalizeTsSeconds(n)
		}
		if dt, err := time.Parse(time.RFC3339, s); err == nil {
			return dt.Unix()
		}
	case map[string]any:
		if sec, ok := t["seconds"].(float64); ok {
			return int64(sec)
		}
		if sec, ok := t["unixSeconds"].(float64); ok {
			return int64(sec)
		}
		if inner, ok := t["value"]; ok {
			return timestampLikeSeconds(inner)
		}
	}
	return 0
}

// normalizeTsSeconds:>1e12 视为毫秒 → 秒;否则按秒。<=0 未知。
func normalizeTsSeconds(raw float64) int64 {
	if raw <= 0 || math.IsNaN(raw) || math.IsInf(raw, 0) {
		return 0
	}
	if raw > 1e12 {
		return int64(raw / 1000)
	}
	return int64(raw)
}

func extractProjectID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if s = strings.TrimSpace(s); s != "" {
			return s
		}
	}
	var obj struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if id := strings.TrimSpace(obj.ID); id != "" {
			return id
		}
	}
	return ""
}

// pickOnboardTier 照搬 cockpit pick_onboard_tier:default > 首个有 id > "LEGACY"。
func pickOnboardTier(tiers []allowedTier) string {
	for _, t := range tiers {
		if t.IsDefault {
			if id := strings.TrimSpace(t.ID); id != "" {
				return id
			}
		}
	}
	for _, t := range tiers {
		if id := strings.TrimSpace(t.ID); id != "" {
			return id
		}
	}
	if len(tiers) > 0 {
		return "LEGACY"
	}
	return ""
}

// normalizeGeminiPlan 照搬 cockpit resolveGeminiPlanBucket 的明确档:ultra/pro/free。
// 关键差异:认不出的 tier **不臆断 FREE**(cockpit getSubscriptionTier 会误默认 FREE,
// 把付费号显示成免费),而是原样返回真实 tier 串,宁可显示 "xxx-tier" 也不误标 FREE。
// 空 tier 返回 ""(keep-prior,不覆盖既有 plan)。
func normalizeGeminiPlan(raw string) string {
	trimmed := strings.TrimSpace(raw)
	l := strings.ToLower(trimmed)
	switch {
	case l == "":
		return ""
	case strings.Contains(l, "ultra"):
		return "ULTRA"
	case l == "standard-tier":
		return "FREE"
	case strings.Contains(l, "pro"), strings.Contains(l, "premium"):
		return "PRO"
	case l == "free-tier", strings.Contains(l, "free"):
		return "FREE"
	default:
		return trimmed // 未知档:显示真实 tier 串,绝不冒充 FREE
	}
}

func tierID(t *cloudCodeTier) string {
	if t == nil {
		return ""
	}
	return strings.TrimSpace(t.ID)
}

func tierName(t *cloudCodeTier) string {
	if t == nil {
		return ""
	}
	return strings.TrimSpace(t.Name)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func pathTail(url string) string {
	if i := strings.LastIndex(url, "/"); i >= 0 && i+1 < len(url) {
		return url[i+1:]
	}
	return url
}
