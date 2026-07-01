package oauthcb

import (
	"errors"
	"testing"
)

func TestParse_FullURL(t *testing.T) {
	cb, err := Parse("http://localhost:1455/auth/callback?code=AbC123&state=xyz789")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "AbC123" || cb.State != "xyz789" {
		t.Fatalf("wrong parse: %+v", cb)
	}
}

func TestParse_LeadingQuestionMark(t *testing.T) {
	cb, err := Parse("?code=code1&state=state1")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "code1" || cb.State != "state1" {
		t.Fatalf("wrong parse: %+v", cb)
	}
}

func TestParse_BareKeyValue(t *testing.T) {
	cb, err := Parse("code=raw&state=st")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "raw" || cb.State != "st" {
		t.Fatalf("wrong parse: %+v", cb)
	}
}

func TestParse_RelativeWithHostNoScheme(t *testing.T) {
	cb, err := Parse("localhost:1455/cb?code=cc&state=ss")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "cc" || cb.State != "ss" {
		t.Fatalf("wrong parse: %+v", cb)
	}
}

func TestParse_Whitespace(t *testing.T) {
	cb, err := Parse("   http://localhost/?code=trim&state=ws  \n")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "trim" || cb.State != "ws" {
		t.Fatalf("wrong parse: %+v", cb)
	}
}

func TestParse_Empty(t *testing.T) {
	if _, err := Parse("   "); !errors.Is(err, ErrEmpty) {
		t.Fatalf("expected ErrEmpty, got %v", err)
	}
}

func TestParse_ErrorParam(t *testing.T) {
	cb, err := Parse("http://localhost/?error=access_denied&error_description=user+said+no")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Error != "access_denied" || cb.ErrorDescription != "user said no" {
		t.Fatalf("wrong error parse: %+v", cb)
	}
	if cb.Code != "" {
		t.Fatalf("expected empty code on error, got %q", cb.Code)
	}
}

func TestParse_ErrorDescriptionPromotedToError(t *testing.T) {
	cb, err := Parse("http://localhost/?error_description=boom")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Error != "boom" || cb.ErrorDescription != "" {
		t.Fatalf("expected description promoted to error: %+v", cb)
	}
}

func TestParse_CodeWithEmbeddedState(t *testing.T) {
	cb, err := Parse("http://localhost/?code=thecode%23thestate")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "thecode" || cb.State != "thestate" {
		t.Fatalf("expected split code#state: %+v", cb)
	}
}

func TestParse_FragmentParams(t *testing.T) {
	cb, err := Parse("http://localhost/cb#code=fragcode&state=fragstate")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cb.Code != "fragcode" || cb.State != "fragstate" {
		t.Fatalf("expected fragment params parsed: %+v", cb)
	}
}

func TestParse_MissingCode(t *testing.T) {
	if _, err := Parse("http://localhost/?state=onlystate"); err == nil {
		t.Fatal("expected error when code missing and no error param")
	}
}

func TestParse_NotAURL(t *testing.T) {
	if _, err := Parse("justsometext"); err == nil {
		t.Fatal("expected error for non-URL bare token")
	}
}
