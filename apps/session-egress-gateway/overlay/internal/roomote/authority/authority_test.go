package authority

import "testing"

func TestParse(t *testing.T) {
	cases := []struct {
		uri, host string
		wantHost  string
		wantPort  int
		ok        bool
	}{
		{"api.example.com:443", "", "api.example.com", 443, true},
		{"API.Example.com.:8443", "api.example.com:8443", "api.example.com", 8443, true},
		{"", "api.example.com:443", "api.example.com", 443, true},
		{"api.example.com", "", "", 0, false},       // no port
		{"10.0.0.1:443", "", "", 0, false},          // literal IPv4
		{"[::1]:443", "", "", 0, false},             // literal IPv6
		{"api.example.com:0", "", "", 0, false},     // port range
		{"api.example.com:70000", "", "", 0, false}, // port range
		{"api.example.com:443", "other.example.com:443", "", 0, false},
		{"api.example.com:443", "api.example.com:8443", "", 0, false},
		{"-bad.example.com:443", "", "", 0, false},
	}
	for _, c := range cases {
		host, port, ok := Parse(c.uri, c.host)
		if ok != c.ok || host != c.wantHost || port != c.wantPort {
			t.Errorf("Parse(%q,%q) = %q,%d,%v want %q,%d,%v", c.uri, c.host, host, port, ok, c.wantHost, c.wantPort, c.ok)
		}
	}
}

func TestHostMatches(t *testing.T) {
	if !HostMatches("api.example.com", "api.example.com", 443) {
		t.Fatal("default port should match 443")
	}
	if HostMatches("api.example.com", "api.example.com", 8443) {
		t.Fatal("default port must not match a non-443 authority")
	}
	if !HostMatches("API.EXAMPLE.COM:8443", "api.example.com", 8443) {
		t.Fatal("case-insensitive match expected")
	}
	if HostMatches("[::1]:443", "api.example.com", 443) {
		t.Fatal("bracketed literal must not match")
	}
}
