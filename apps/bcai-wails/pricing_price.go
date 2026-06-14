package main

import (
	_ "embed"
	"encoding/json"
)

//go:embed pricing.json
var pricingJSON []byte

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
