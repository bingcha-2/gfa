package modelprovider

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// mockDoer 是注入用的 http.Client 桩。
type mockDoer struct {
	resp *http.Response
	err  error
	req  *http.Request
}

func (m *mockDoer) Do(req *http.Request) (*http.Response, error) {
	m.req = req
	return m.resp, m.err
}

func jsonResp(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}
}

const modelsJSON = `{"data":[{"id":"gpt-5","display_name":"GPT 5"},{"id":"gpt-4o"},{"id":"gpt-5"},{"id":""}]}`

func TestConnectionSuccess(t *testing.T) {
	m := &mockDoer{resp: jsonResp(200, modelsJSON)}
	p := Provider{Name: "a", BaseURL: "https://api.openai.com/v1", APIKey: "secret"}
	res := TestConnection(p, m)
	if !res.OK || res.Status != 200 {
		t.Fatalf("expected ok 200, got %+v", res)
	}
	if res.Model != "gpt-5" {
		t.Fatalf("expected first model gpt-5, got %q", res.Model)
	}
	// 校验请求带 bearer + 打到 /models。
	if got := m.req.Header.Get("Authorization"); got != "Bearer secret" {
		t.Fatalf("auth header = %q", got)
	}
	if !strings.HasSuffix(m.req.URL.String(), "/v1/models") {
		t.Fatalf("url = %s", m.req.URL.String())
	}
}

func TestConnectionMissingKey(t *testing.T) {
	res := TestConnection(Provider{BaseURL: "https://x"}, &mockDoer{})
	if res.OK || res.Err != "MISSING_API_KEY" {
		t.Fatalf("expected missing key failure, got %+v", res)
	}
}

func TestConnectionHTTPError(t *testing.T) {
	m := &mockDoer{resp: jsonResp(401, `{"error":"bad key"}`)}
	res := TestConnection(Provider{BaseURL: "https://x", APIKey: "k"}, m)
	if res.OK || res.Status != 401 || res.Err != "HTTP_STATUS" {
		t.Fatalf("expected 401 HTTP_STATUS, got %+v", res)
	}
}

func TestConnectionNetworkError(t *testing.T) {
	m := &mockDoer{err: io.ErrUnexpectedEOF}
	res := TestConnection(Provider{BaseURL: "https://x", APIKey: "k"}, m)
	if res.OK || res.Err == "" {
		t.Fatalf("expected network failure, got %+v", res)
	}
}

func TestListModelsSuccess(t *testing.T) {
	m := &mockDoer{resp: jsonResp(200, modelsJSON)}
	res, err := ListModels(Provider{BaseURL: "https://api.openai.com/v1", APIKey: "k"}, m)
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	// 去重(gpt-5 一次)+ 丢空 id → 2 条。
	if len(res.Models) != 2 {
		t.Fatalf("expected 2 models, got %+v", res.Models)
	}
	if res.Models[0].ID != "gpt-5" || res.Models[0].DisplayName != "GPT 5" {
		t.Fatalf("first model = %+v", res.Models[0])
	}
	if res.Models[1].ID != "gpt-4o" {
		t.Fatalf("second model = %+v", res.Models[1])
	}
}

func TestListModelsHTTPError(t *testing.T) {
	m := &mockDoer{resp: jsonResp(500, "boom")}
	if _, err := ListModels(Provider{BaseURL: "https://x", APIKey: "k"}, m); err == nil {
		t.Fatal("expected error on 500")
	}
}

func TestListModelsMissingKey(t *testing.T) {
	if _, err := ListModels(Provider{BaseURL: "https://x"}, &mockDoer{}); err == nil {
		t.Fatal("expected error for missing key")
	}
}
