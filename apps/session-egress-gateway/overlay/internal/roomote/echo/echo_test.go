package echo

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

const cred = "sk-live-Qm9vayBvZiBTZWNyZXRz+/=="

func TestMixedCaseUnicodeJSON(t *testing.T) {
	const key = "JKLMNOJKLMNOJKLMNO"
	var escaped strings.Builder
	for i, r := range key {
		format := "\\u%04x"
		if i%2 == 1 {
			format = "\\u%04X"
		}
		fmt.Fprintf(&escaped, format, r)
	}
	body := []byte(`"` + escaped.String() + `"`)
	var decoded string
	if err := json.Unmarshal(body, &decoded); err != nil || decoded != key {
		t.Fatal("fixture must be valid JSON for the original value")
	}
	s := New(key)
	if !s.Contains(body) || !s.ContainsString(string(body)) {
		t.Error("missed mixed-case unicode escapes")
	}
	st := s.NewStream()
	var emitted []byte
	var detected bool
	for start := 0; start < len(body); start += 5 {
		end := min(start+5, len(body))
		out, err := st.Feed(body[start:end])
		emitted = append(emitted, out...)
		if errors.Is(err, ErrEcho) {
			detected = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !detected {
		out, err := st.Flush()
		emitted = append(emitted, out...)
		detected = errors.Is(err, ErrEcho)
	}
	if !detected || bytes.Contains(emitted, []byte(`\u004`)) {
		t.Fatal("mixed-case credential was not held and suppressed")
	}
	// Flush must apply the same matching rules, even without another chunk.
	flush := &Stream{s: s, pending: body}
	if out, err := flush.Flush(); !errors.Is(err, ErrEcho) || len(out) != 0 {
		t.Fatal("flush missed mixed-case credential")
	}
	for _, miss := range []string{
		strings.ToLower(key),
		strings.ReplaceAll(escaped.String(), `\u`, `\U`),
		strings.ReplaceAll(escaped.String(), "004", "006"),
		strings.ReplaceAll(escaped.String(), "004", "00g"),
	} {
		if s.ContainsString(miss) {
			t.Errorf("changed credential or invalid escape matched: %q", miss)
		}
	}
}

func TestUnicodeJSONEncodings(t *testing.T) {
	for _, format := range []string{"\\u%04x", "\\u%04X"} {
		t.Run(format, func(t *testing.T) {
			var escaped strings.Builder
			for _, r := range cred {
				fmt.Fprintf(&escaped, format, r)
			}
			body := []byte(`"` + escaped.String() + `"`)
			var decoded string
			if err := json.Unmarshal(body, &decoded); err != nil || decoded != cred {
				t.Fatalf("invalid credential JSON: %q, %v", decoded, err)
			}
			s := New(cred)
			if !s.Contains(body) {
				t.Error("missed valid unicode-escaped JSON")
			}
			for split := 2; split < len(body)-2; split++ {
				st := s.NewStream()
				out, err := st.Feed(body[:split])
				if err != nil || len(out) != 0 {
					t.Fatalf("split %d: first chunk not held: %q, %v", split, out, err)
				}
				out, err = st.Feed(body[split:])
				if !errors.Is(err, ErrEcho) || len(out) != 0 {
					t.Fatalf("split %d: echo not suppressed: %q, %v", split, out, err)
				}
			}
		})
	}
}

func TestContainsEncodings(t *testing.T) {
	s := New(cred)
	hits := []string{
		`{"key":"` + cred + `"}`,
		"authorization: Bearer " + cred,
		base64.StdEncoding.EncodeToString([]byte(cred)),
		base64.RawURLEncoding.EncodeToString([]byte(cred)),
		// Embedded at every base64 alignment, with unrelated bytes around it.
		base64.StdEncoding.EncodeToString([]byte("Bearer " + cred + " tail")),
		base64.StdEncoding.EncodeToString([]byte("u:" + cred)),
		base64.URLEncoding.EncodeToString([]byte("x" + cred + "yz")),
		"https://x.test/?k=" + url.QueryEscape(cred),
	}
	for _, h := range hits {
		if !s.ContainsString(h) {
			t.Errorf("expected hit for %q", h)
		}
	}
	misses := []string{"", "hello world", "sk-live-other", cred[:len(cred)-1]}
	for _, m := range misses {
		if s.ContainsString(m) {
			t.Errorf("unexpected hit for %q", m)
		}
	}
}

func TestStreamCatchesStraddle(t *testing.T) {
	s := New(cred)
	body := []byte("prefix data " + cred + " suffix data")
	// Split in the middle of the credential.
	split := len("prefix data ") + len(cred)/2
	st := s.NewStream()
	out1, err := st.Feed(body[:split])
	if err != nil {
		t.Fatalf("unexpected early detection: %v", err)
	}
	// Nothing from the credential's first half may have been released.
	if bytes.Contains(out1, []byte(cred[:4])) {
		t.Fatalf("released credential prefix: %q", out1)
	}
	if _, err := st.Feed(body[split:]); !errors.Is(err, ErrEcho) {
		t.Fatalf("err = %v, want ErrEcho", err)
	}
}

func TestStreamReleasesCleanDataAndFlushes(t *testing.T) {
	s := New(cred)
	st := s.NewStream()
	var got []byte
	chunks := [][]byte{[]byte("data: hello\n\n"), []byte("data: wor"), []byte("ld\n\ndata: tail-no-newline")}
	for _, c := range chunks {
		out, err := st.Feed(c)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, out...)
	}
	// Line-delimited content up to the last newline is released immediately.
	if !bytes.HasSuffix(got, []byte("world\n\n")) {
		t.Fatalf("expected everything through the last newline released, got %q", got)
	}
	tail, err := st.Flush()
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, tail...)
	want := bytes.Join(chunks, nil)
	if !bytes.Equal(got, want) {
		t.Fatalf("stream altered bytes:\n got %q\nwant %q", got, want)
	}
}

func TestStreamHoldbackBounded(t *testing.T) {
	s := New(cred)
	st := s.NewStream()
	big := bytes.Repeat([]byte("x"), 10_000)
	out, err := st.Feed(big)
	if err != nil {
		t.Fatal(err)
	}
	if held := len(big) - len(out); held != s.MaxPatternLen()-1 {
		t.Fatalf("held back %d bytes, want %d", held, s.MaxPatternLen()-1)
	}
}

func TestNilScannerPassesThrough(t *testing.T) {
	var s *Scanner
	if s.Contains([]byte("anything")) {
		t.Fatal("nil scanner must not match")
	}
	st := s.NewStream()
	out, err := st.Feed([]byte("abc"))
	if err != nil || string(out) != "abc" {
		t.Fatalf("nil stream: %q %v", out, err)
	}
}
