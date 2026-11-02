package main

import (
	_ "embed"
	"encoding/json"
	"strings"
	"time"
)

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
	Version     string          `json:"version"`
	EffectiveAt int64           `json:"effectiveAt"`
	Models      []apiPriceModel `json:"models"`
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

func findAPIPriceModel(registry apiPriceRegistry, provider, modelID string, at time.Time) *apiPriceModel {
	id := strings.ToLower(strings.TrimSpace(modelID))
	var found *apiPriceModel
	bestMatch := 0
	for i := range registry.Models {
		model := &registry.Models[i]
		if model.Provider != provider || !apiModelActiveAt(*model, at) {
			continue
		}
		matchLength := 0
		for _, alias := range append([]string{model.CanonicalModelID}, model.Aliases...) {
			normalized := strings.ToLower(strings.TrimSpace(alias))
			isDatedSnapshot := false
			if strings.HasPrefix(id, normalized+"-") {
				suffix := strings.TrimPrefix(id, normalized+"-")
				datePart := suffix
				if len(datePart) >= 10 && datePart[4] == '-' && datePart[7] == '-' {
					datePart = datePart[:10]
				} else if len(datePart) >= 8 {
					datePart = datePart[:8]
				}
				_, compactErr := time.Parse("20060102", datePart)
				_, dashedErr := time.Parse("2006-01-02", datePart)
				isDatedSnapshot = compactErr == nil || dashedErr == nil
			}
			if id == normalized || isDatedSnapshot {
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
	registry := apiPriceSnapshotAt(at)
	model := findAPIPriceModel(registry, provider, modelID, at)
	quality, contextTier := "exact", "short"
	canonical := provider + "-unknown-conservative"
	var price apiTokenPrice
	if model == nil {
		price = apiTokenPrice{}
		quality, contextTier = "conservative-fallback", "unknown"
	} else {
		canonical = model.CanonicalModelID
		requested := "short"
		if model.ContextThreshold > 0 && contextTokens > model.ContextThreshold {
			requested = "long"
		}
		prices, ok := model.Modes[mode]
		if !ok {
			price = apiTokenPrice{}
			quality, contextTier = "conservative-fallback", "unknown"
		} else {
			selected := prices.Short
			if requested == "long" {
				selected = prices.Long
			}
			if selected == nil {
				price = apiTokenPrice{}
				quality, contextTier = "unsupported-context", "unknown"
			} else {
				contextTier = requested
				price = *selected
			}
		}
	}
	usd := (positiveTokens(input)*price.Input + positiveTokens(output)*price.Output +
		positiveTokens(cacheRead)*price.CacheRead + positiveTokens(cacheWrite5m)*price.CacheWrite5m +
		positiveTokens(cacheWrite1h)*price.CacheWrite1h) / 1_000_000
	return apiValue{USD: usd, CanonicalModelID: canonical, PricingVersion: registry.Version,
		PricingMode: mode, ContextTier: contextTier, Quality: quality}
}
