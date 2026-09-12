// Package echo detects the injected real credential in upstream responses so
// the gateway can suppress an upstream that reflects the credential back to
// the workload (debug endpoints, error pages that echo headers, misconfigured
// mocks, hostile servers).
//
// Iron has no response-side leak scanner (its bodycapture is request-only to
// keep SSE streaming intact), so this is original to the gateway. Matching is
// exact byte matching over a small fixed set of encodings of the credential:
// raw, base64 alignment windows (standard/URL), percent, JSON and hex encoding.
// Substring matching over arbitrary transforms is out of scope by design.
package echo

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf16"
)

// ErrEcho is returned when a credential encoding is found.
var ErrEcho = errors.New("echo: credential material detected in upstream response")

// Scanner matches encodings of one credential value.
type Scanner struct {
	patterns [][]byte
	unicode  []byte
	maxLen   int
}

// New builds a scanner for value. Patterns shorter than minPatternLen are
// dropped so trivially short credentials cannot produce constant false
// positives; the raw value is always kept.
func New(value string) *Scanner {
	const minPatternLen = 8
	seen := map[string]struct{}{}
	add := func(p string) {
		if p == "" {
			return
		}
		if _, dup := seen[p]; dup {
			return
		}
		seen[p] = struct{}{}
	}
	add(value)
	raw := []byte(value)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
		for _, p := range base64Alignments(enc, raw) {
			add(p)
		}
	}
	add(url.QueryEscape(value))
	add(url.PathEscape(value))
	// Lower-case hex escapes are what many clients/servers emit.
	lowerEscapes := func(s string) string {
		b := []byte(s)
		for i := 0; i+2 < len(b); i++ {
			if b[i] == '%' {
				copy(b[i+1:i+3], strings.ToLower(string(b[i+1:i+3])))
				i += 2
			}
		}
		return string(b)
	}
	add(lowerEscapes(url.QueryEscape(value)))
	add(lowerEscapes(url.PathEscape(value)))
	var percent, unicode strings.Builder
	for _, b := range raw {
		fmt.Fprintf(&percent, "%%%02X", b)
	}
	for _, r := range utf16.Encode([]rune(value)) {
		fmt.Fprintf(&unicode, "\\u%04x", r)
	}
	add(percent.String())
	add(lowerEscapes(percent.String()))
	add(unicode.String())
	add(hex.EncodeToString(raw))
	add(strings.ToUpper(hex.EncodeToString(raw)))
	encoded, _ := json.Marshal(value) // A string is always JSON encodable.
	add(string(encoded[1 : len(encoded)-1]))

	s := &Scanner{}
	if unicode.Len() >= minPatternLen {
		s.unicode = []byte(unicode.String())
	}
	for p := range seen {
		if p != value && len(p) < minPatternLen {
			continue
		}
		b := []byte(p)
		s.patterns = append(s.patterns, b)
		if len(b) > s.maxLen {
			s.maxLen = len(b)
		}
	}
	return s
}

// Contains reports whether b contains any pattern.
func (s *Scanner) Contains(b []byte) bool {
	if s == nil {
		return false
	}
	for _, p := range s.patterns {
		if bytes.Contains(b, p) {
			return true
		}
	}
	// Fold only hex digits of valid lowercase-\u escapes. Raw credential bytes
	// remain case-sensitive, and arbitrary per-escape casing needs no enumeration.
	if len(s.unicode) > 0 && bytes.Contains(b, []byte(`\u`)) {
		normalized := bytes.Clone(b)
		for i := 0; i+5 < len(normalized); i++ {
			if normalized[i] != '\\' || normalized[i+1] != 'u' {
				continue
			}
			valid := true
			for _, digit := range normalized[i+2 : i+6] {
				if !((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f') || (digit >= 'A' && digit <= 'F')) {
					valid = false
					break
				}
			}
			if !valid {
				continue
			}
			for j := i + 2; j < i+6; j++ {
				if normalized[j] >= 'A' && normalized[j] <= 'F' {
					normalized[j] += 'a' - 'A'
				}
			}
			i += 5
		}
		return bytes.Contains(normalized, s.unicode)
	}
	return false
}

// ContainsString is Contains for strings.
func (s *Scanner) ContainsString(str string) bool {
	return s.Contains([]byte(str))
}

// MaxPatternLen is the longest pattern length (the cross-chunk window size
// minus one).
func (s *Scanner) MaxPatternLen() int {
	if s == nil {
		return 0
	}
	return s.maxLen
}

// Stream scans a byte stream chunk by chunk while holding back a tail window
// so a credential that straddles two chunks is caught before either half is
// released. No pattern contains CR or LF (header values cannot, and the
// encodings never introduce them), so the window never needs to reach back
// past the last newline; for line-delimited streams such as SSE this means
// complete events are released without delay.
type Stream struct {
	s       *Scanner
	pending []byte
}

// NewStream starts a streaming scan.
func (s *Scanner) NewStream() *Stream { return &Stream{s: s} }

// Feed scans pending+chunk and returns the bytes that are safe to release now.
// On detection it returns ErrEcho and releases nothing.
func (st *Stream) Feed(chunk []byte) ([]byte, error) {
	if st.s == nil {
		return chunk, nil
	}
	buf := append(st.pending, chunk...)
	st.pending = nil
	if st.s.Contains(buf) {
		return nil, ErrEcho
	}
	hold := st.s.maxLen - 1
	if hold < 0 {
		hold = 0
	}
	if hold > len(buf) {
		hold = len(buf)
	}
	if nl := bytes.LastIndexAny(buf, "\r\n"); nl >= 0 && len(buf)-1-nl < hold {
		hold = len(buf) - 1 - nl
	}
	cut := len(buf) - hold
	emit := buf[:cut:cut]
	if hold > 0 {
		st.pending = append([]byte(nil), buf[cut:]...)
	}
	return emit, nil
}

// Flush releases whatever is held back at end of stream.
func (st *Stream) Flush() ([]byte, error) {
	out := st.pending
	st.pending = nil
	if st.s != nil && st.s.Contains(out) {
		return nil, ErrEcho
	}
	return out, nil
}

// base64Alignments returns the encodings of raw at each of the three byte
// offsets base64 can start from, trimmed to the character groups that depend
// on raw alone. A credential embedded in a larger base64 blob (a Basic
// header, a JSON debug dump) lands on one of these alignments, so matching
// all three catches it regardless of what precedes or follows it. The
// alignment-0 variant is the plain encoding minus any final partial group.
func base64Alignments(enc *base64.Encoding, raw []byte) []string {
	var out []string
	for shift := 0; shift < 3; shift++ {
		padded := append(make([]byte, shift), raw...)
		encoded := enc.EncodeToString(padded)
		fullGroups := len(padded) / 3
		start := 0
		if shift > 0 {
			start = 4 // first group mixes in the unknown preceding bytes
		}
		end := fullGroups * 4
		if end <= start {
			continue
		}
		out = append(out, encoded[start:end])
	}
	return out
}
