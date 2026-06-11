package main

import "strings"

// product_bucket.go — 客户端侧「产品 / 族 / 桶」命名与来回映射的唯一真源,
// 与服务端 apps/server/src/lease-core/product-bucket.ts 语义保持一致。
//
//   产品 Product : 卡售卖的顶层轴 — antigravity | codex | anthropic。
//   族   Family  : 模型属于哪家厂商 — gemini | claude | gpt。由模型名推断,
//                  不是独立的轴,只作桶后缀。
//   桶   Bucket  : 计费/额度/血条 key,恒为复合键 `<product>-<family>`。
//
// 规则:任何额度/计费 key = bucketKey(product, model)。产品前缀使「同一个 Claude
// 模型经 antigravity 与经 anthropic」落到两个不同的桶(antigravity-claude vs
// anthropic-claude),永不串号。模块外不得再实现模型分类。
//
// isGeminiModel / isCodexModel 复用 leaser_status.go 中的定义。

// modelFamily 把模型名归类到厂商族。claude 为兜底。
func modelFamily(modelKey string) string {
	if isGeminiModel(modelKey) {
		return "gemini"
	}
	if isCodexModel(modelKey) {
		return "gpt"
	}
	return "claude"
}

// bucketKey 拼出某产品下某模型的复合计费桶 key。唯一拼桶入口。
func bucketKey(product, modelKey string) string {
	return product + "-" + modelFamily(modelKey)
}

// parseBucket 把复合桶 key 拆回 (product, family)。唯一拆桶入口。
func parseBucket(bucket string) (product, family string) {
	idx := strings.Index(bucket, "-")
	if idx < 0 {
		return bucket, ""
	}
	return bucket[:idx], bucket[idx+1:]
}

func productOfBucket(bucket string) string {
	p, _ := parseBucket(bucket)
	return p
}

func familyOfBucket(bucket string) string {
	_, f := parseBucket(bucket)
	return f
}

// productLabel 复用 takeover.go 中的既有定义。

var familyLabels = map[string]string{
	"gemini": "Gemini",
	"claude": "Claude",
	"gpt":    "GPT",
}

func familyLabel(family string) string {
	if l, ok := familyLabels[family]; ok {
		return l
	}
	return family
}

// bucketLabel 复合桶 key 的人类可读名,如 "Antigravity · Claude"。
func bucketLabel(bucket string) string {
	product, family := parseBucket(bucket)
	if family == "" {
		return productLabel(product)
	}
	return productLabel(product) + " · " + familyLabel(family)
}
