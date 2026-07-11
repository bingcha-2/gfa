package main

import (
	_ "embed"
	"encoding/json"
	"strings"
	"time"
)

//go:embed pricing.json
var pricingJSON []byte

//go:embed api-pricing.json
var apiPricingJSON []byte

type apiTokenPrice struct {
	Input        float64 `json:"input"`
	CacheRead    float64 `json:"cacheRead"`
	CacheWrite5m float64 `json:"cacheWrite5m"`
	CacheWrite1h float64 `json:"cacheWrite1h"`
	Output       float64 `json:"output"`
}

type apiPriceMode struct {
	Short *apiTokenPrice `json:"short"`
	Long  *apiTokenPrice `json:"long"`
}

type apiPriceModel struct {
	Provider         string                  `json:"provider"`
	CanonicalModelID string                  `json:"canonicalModelId"`
	Aliases          []string                `json:"aliases"`
	EffectiveFrom    string                  `json:"effectiveFrom"`
	EffectiveUntil   string                  `json:"effectiveUntil"`
	ContextThreshold int64                   `json:"contextThreshold"`
	Modes            map[string]apiPriceMode `json:"modes"`
}

type apiPriceRegistry struct {
	Version string          `json:"version"`
	Models  []apiPriceModel `json:"models"`
}

var exactAPIPrices = func() apiPriceRegistry {
	var registry apiPriceRegistry
	_ = json.Unmarshal(apiPricingJSON, &registry)
	return registry
}()

type apiValue struct {
	USD              float64
	CanonicalModelID string
	PricingVersion   string
	PricingMode      string
	ContextTier      string
	Quality          string
}

func apiModelActiveAt(model apiPriceModel, at time.Time) bool {
	from, err := time.Parse(time.RFC3339, model.EffectiveFrom)
	if err != nil || at.Before(from) {
		return false
	}
	if model.EffectiveUntil == "" {
		return true
	}
	until, err := time.Parse(time.RFC3339, model.EffectiveUntil)
	return err == nil && at.Before(until)
}

func findAPIPriceModel(provider, modelID string, at time.Time) *apiPriceModel {
	id := strings.ToLower(strings.TrimSpace(modelID))
	var found *apiPriceModel
	bestMatch := 0
	for i := range exactAPIPrices.Models {
		model := &exactAPIPrices.Models[i]
		if model.Provider != provider || !apiModelActiveAt(*model, at) {
			continue
		}
		matchLength := 0
		for _, alias := range append([]string{model.CanonicalModelID}, model.Aliases...) {
			normalized := strings.ToLower(strings.TrimSpace(alias))
			if id == normalized || strings.HasPrefix(id, normalized+"-") {
				if len(normalized) > matchLength {
					matchLength = len(normalized)
				}
			}
		}
		if matchLength > bestMatch {
			found = model
			bestMatch = matchLength
		}
	}
	return found
}

func conservativeAPIPrice(provider, mode string, at time.Time) apiTokenPrice {
	var result apiTokenPrice
	for _, model := range exactAPIPrices.Models {
		if model.Provider != provider || !apiModelActiveAt(model, at) {
			continue
		}
		prices, ok := model.Modes[mode]
		if !ok {
			continue
		}
		for _, price := range []*apiTokenPrice{prices.Short, prices.Long} {
			if price == nil {
				continue
			}
			if price.Input > result.Input {
				result.Input = price.Input
			}
			if price.CacheRead > result.CacheRead {
				result.CacheRead = price.CacheRead
			}
			if price.CacheWrite5m > result.CacheWrite5m {
				result.CacheWrite5m = price.CacheWrite5m
			}
			if price.CacheWrite1h > result.CacheWrite1h {
				result.CacheWrite1h = price.CacheWrite1h
			}
			if price.Output > result.Output {
				result.Output = price.Output
			}
		}
	}
	return result
}

func positiveTokens(value int64) float64 {
	if value <= 0 {
		return 0
	}
	return float64(value)
}

func calculateAPIValue(provider, modelID, mode string, contextTokens, input, output, cacheRead, cacheWrite5m, cacheWrite1h int64, at time.Time) apiValue {
	if mode != "priority" {
		mode = "standard"
	}
	model := findAPIPriceModel(provider, modelID, at)
	quality, contextTier := "exact", "short"
	canonical := provider + "-unknown-conservative"
	var price apiTokenPrice
	if model == nil {
		price = conservativeAPIPrice(provider, mode, at)
		quality, contextTier = "conservative-fallback", "unknown"
	} else {
		canonical = model.CanonicalModelID
		requested := "short"
		if model.ContextThreshold > 0 && contextTokens >= model.ContextThreshold {
			requested = "long"
		}
		prices, ok := model.Modes[mode]
		if !ok {
			prices = model.Modes["standard"]
		}
		selected := prices.Short
		if requested == "long" {
			selected = prices.Long
		}
		if selected == nil {
			selected = prices.Short
			if selected == nil {
				selected = model.Modes["standard"].Short
			}
			quality, contextTier = "unsupported-context", "unknown"
		} else {
			contextTier = requested
		}
		if selected != nil {
			price = *selected
		}
	}
	usd := (positiveTokens(input)*price.Input + positiveTokens(output)*price.Output +
		positiveTokens(cacheRead)*price.CacheRead + positiveTokens(cacheWrite5m)*price.CacheWrite5m +
		positiveTokens(cacheWrite1h)*price.CacheWrite1h) / 1_000_000
	return apiValue{USD: usd, CanonicalModelID: canonical, PricingVersion: exactAPIPrices.Version,
		PricingMode: mode, ContextTier: contextTier, Quality: quality}
}

type familyPrice struct {
	InputPerM      float64 `json:"inputPerM"`
	OutputPerM     float64 `json:"outputPerM"`
	CacheReadPerM  float64 `json:"cacheReadPerM"`
	CacheWritePerM float64 `json:"cacheWritePerM"` // 缓存写(claude≈1.25×输入溢价;gpt 无溢价=输入)
}

var familyPricing = func() map[string]familyPrice {
	m := map[string]familyPrice{}
	_ = json.Unmarshal(pricingJSON, &m)
	return m
}()

// priceFor 返回某家族 输入/输出 美元每百万 token。未知家族回退 gemini。
func priceFor(family string) (inPerM, outPerM float64) {
	p, ok := familyPricing[family]
	if !ok {
		p = familyPricing["gemini"]
	}
	return p.InputPerM, p.OutputPerM
}

// cachePriceFor 返回某家族 缓存读/缓存写 美元每百万 token(用于真实成本/节省估算)。
// 缓存读 ≈ 0.1×输入(折扣),缓存写 ≈ 1.25×输入(claude/gemini 溢价;gpt 无溢价)。未知家族回退 gemini。
func cachePriceFor(family string) (cacheReadPerM, cacheWritePerM float64) {
	p, ok := familyPricing[family]
	if !ok {
		p = familyPricing["gemini"]
	}
	return p.CacheReadPerM, p.CacheWritePerM
}
