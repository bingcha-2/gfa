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
