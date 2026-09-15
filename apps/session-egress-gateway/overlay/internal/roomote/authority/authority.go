// Package authority validates CONNECT authorities the way the control plane
// expects them: a lowercase DNS name (never a literal IP) with an explicit
// port. It is shared by the gateway (which enforces it) and the connector
// (which refuses obviously invalid tunnels before dialling the gateway).
package authority

import (
	"net"
	"regexp"
	"strconv"
	"strings"
)

// hostRe mirrors destinationHostSchema in @roomote/types: lowercase DNS names only.
var hostRe = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// LowerHost normalises a host for comparison: lowercase, no trailing dot.
func LowerHost(h string) string { return strings.ToLower(strings.TrimSuffix(h, ".")) }

// Parse validates a CONNECT authority. It must be `host:port` with a
// lowercase-able DNS name (never a literal IP) and an explicit port in range.
// When the Host header is present it must agree with the request target.
func Parse(requestURI, hostHeader string) (string, int, bool) {
	target := requestURI
	if target == "" {
		target = hostHeader
	}
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return "", 0, false
	}
	host = LowerHost(host)
	if !hostRe.MatchString(host) || len(host) > 253 {
		return "", 0, false
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, false
	}
	if hostHeader != "" {
		hh, hp, err := net.SplitHostPort(hostHeader)
		if err != nil {
			hh, hp = hostHeader, "443"
		}
		if LowerHost(hh) != host || hp != portStr {
			return "", 0, false
		}
	}
	return host, port, true
}

// HostMatches checks an inner Host header (or absolute-form URL host) against
// an authority; a missing port implies 443.
func HostMatches(hostValue, host string, port int) bool {
	if hostValue == "" {
		return false
	}
	h, p, err := net.SplitHostPort(hostValue)
	if err != nil {
		h, p = hostValue, "443"
	}
	if strings.HasPrefix(h, "[") { // stray bracketed literal
		return false
	}
	return LowerHost(h) == host && p == strconv.Itoa(port)
}

// ValidHost reports whether h is an acceptable lowercase DNS destination name.
func ValidHost(h string) bool { return hostRe.MatchString(h) && len(h) <= 253 }
