package echo

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/url"
	"testing"
)

const cred = "sk-live-Qm9vayBvZiBTZWNyZXRz+/=="

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
