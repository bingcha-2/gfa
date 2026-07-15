package main

// 本地「模型厂商」接管:把 codex config.toml 指向一个自定义 OpenAI 兼容供应商
// (对齐 cockpit codex_local_access 的自定义 provider 表)。这是第三种接管源(provider),
// 与「远程托管(openai_base_url 指向租号代理)」「本地自有号(注入 auth.json)」互斥:
// 三者都只能有一个写在 config.toml / auth.json 上,切换即先还原再写。
//
// 用【固定】的 config.toml 表名 gfa_local_provider(不用内部 provider id),这样还原时
// 永远知道该删哪张表,无需在备份里记 id。内部 modelprovider.ID 只用于查出要写哪个 baseURL/key。

const codexLocalProviderID = "gfa_local_provider"

// codexProviderSpec 是写进 config.toml 自定义 provider 表所需的字段(来自 modelprovider.Provider)。
type codexProviderSpec struct {
	Name    string
	BaseURL string
	APIKey  string
	WireAPI string // "responses" | "chat_completions"
}

// InjectCodexProvider 把 config.toml 的 model_provider 指向固定的自定义 provider 表,
// 并写入该表(name/base_url/wire_api/requires_openai_auth[/experimental_bearer_token])。
// 先备份原状(复用 ensureCodexBackup)+ 清掉旧接管残留,保证与其他两种源互斥。
func InjectCodexProvider(spec codexProviderSpec) error {
	content, had, err := readCodexConfigRaw()
	if err != nil {
		return err
	}
	if err := ensureCodexBackup(had); err != nil {
		return err
	}

	// 清旧接管残留:legacy base_url、bingchaai 表、以及顶层 openai_base_url(那是内置 openai
	// provider 的;自定义 provider 走表内 base_url,留着顶层键会误导)。
	content = stripLegacyLocalCodexBaseURL(content)
	content = removeProviderTable(content, codexProviderID)
	content = removeTopLevelKey(content, codexOpenAIBaseURL)

	content = setTopLevelString(content, codexModelProvider, codexLocalProviderID)
	content = upsertProviderTable(content, codexLocalProviderID, codexProviderFields(spec))
	return writeFileAtomic(codexConfigPath(), []byte(content), 0o644)
}

// codexProviderFields 组装 [model_providers.gfa_local_provider] 的有序字段。
func codexProviderFields(spec codexProviderSpec) [][2]string {
	wire := spec.WireAPI
	if wire == "" {
		wire = "responses"
	}
	fields := [][2]string{
		{"name", tomlQuote(spec.Name)},
		{"base_url", tomlQuote(spec.BaseURL)},
		{"wire_api", tomlQuote(wire)},
	}
	if spec.APIKey != "" {
		// 与 cockpit 一致:内联 bearer token(codex 直连自定义厂商时携带鉴权)。
		fields = append(fields,
			[2]string{"requires_openai_auth", "true"},
			[2]string{"experimental_bearer_token", tomlQuote(spec.APIKey)},
		)
	} else {
		fields = append(fields, [2]string{"requires_openai_auth", "false"})
	}
	return fields
}
