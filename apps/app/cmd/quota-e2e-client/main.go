package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

type operation struct {
	Method      string                 `json:"method"`
	Path        string                 `json:"path"`
	Body        map[string]interface{} `json:"body"`
	Parallel    int                    `json:"parallel"`
	AllowStatus int                    `json:"allowStatus"`
}
type scenario struct {
	CardID     string      `json:"cardId"`
	Operations []operation `json:"operations"`
}
type result struct {
	Status int                    `json:"status"`
	Body   map[string]interface{} `json:"body"`
}

func token(card string) string {
	enc := func(v interface{}) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	return enc(map[string]string{"alg": "HS256", "typ": "JWT"}) + "." + enc(map[string]string{"typ": "user-session", "sub": "e2e", "cardId": card}) + ".sig"
}

func replace(v interface{}, lease string, i int) interface{} {
	switch x := v.(type) {
	case string:
		x = strings.ReplaceAll(x, "$leaseId", lease)
		x = strings.ReplaceAll(x, "$i", fmt.Sprint(i))
		return x
	case map[string]interface{}:
		out := map[string]interface{}{}
		for k, value := range x {
			out[k] = replace(value, lease, i)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(x))
		for j, value := range x {
			out[j] = replace(value, lease, i)
		}
		return out
	default:
		return v
	}
}

func call(client *http.Client, base, jwt, lease string, op operation, i int) (result, error) {
	body := replace(op.Body, lease, i)
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(op.Method, base+op.Path, bytes.NewReader(b))
	if err != nil {
		return result{}, err
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return result{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	parsed := map[string]interface{}{}
	_ = json.Unmarshal(raw, &parsed)
	if resp.StatusCode >= 400 && resp.StatusCode != op.AllowStatus {
		return result{}, fmt.Errorf("%s: HTTP %d %s", op.Path, resp.StatusCode, raw)
	}
	return result{Status: resp.StatusCode, Body: parsed}, nil
}

func main() {
	base := flag.String("base", "", "server base URL")
	file := flag.String("scenario", "", "scenario JSON")
	flag.Parse()
	raw, err := os.ReadFile(*file)
	if err != nil {
		panic(err)
	}
	var s scenario
	if err := json.Unmarshal(raw, &s); err != nil {
		panic(err)
	}
	client := &http.Client{}
	jwt, lease := token(s.CardID), ""
	results := []result{}
	for _, op := range s.Operations {
		count := op.Parallel
		if count <= 0 {
			count = 1
		}
		batch := make([]result, count)
		errs := make([]error, count)
		var wg sync.WaitGroup
		for i := 0; i < count; i++ {
			wg.Add(1)
			go func(i int) { defer wg.Done(); batch[i], errs[i] = call(client, *base, jwt, lease, op, i) }(i)
		}
		wg.Wait()
		for i, e := range errs {
			if e != nil {
				panic(e)
			}
			results = append(results, batch[i])
			if id, ok := batch[i].Body["leaseId"].(string); ok && id != "" {
				lease = id
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"leaseId": lease, "responses": results})
}
