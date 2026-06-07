package main

import (
	_ "embed"
	"encoding/json"
)

//go:embed pricing.json
var pricingJSON []byte

type familyPrice struct {
	InputPerM     float64 `json:"inputPerM"`
	OutputPerM    float64 `json:"outputPerM"`
	CacheReadPerM float64 `json:"cacheReadPerM"`
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

// familyFromModel 由模型名推断厂商家族。antigravity 默认走 gemini。
func familyFromModel(model string) string {
	switch {
	case len(model) >= 6 && model[:6] == "claude":
		return "claude"
	case len(model) >= 3 && (model[:3] == "gpt" || model[:1] == "o"):
		return "gpt"
	default:
		return "gemini"
	}
}
