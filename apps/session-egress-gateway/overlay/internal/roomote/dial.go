package roomote

import (
	"context"
	"net"
	"net/netip"
	"strconv"
	"syscall"
	"time"
)

var deniedCIDRs = []string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
	"192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20",
}

func publicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, raw := range deniedCIDRs {
		if netip.MustParsePrefix(raw).Contains(ip) {
			return false
		}
	}
	return true
}
func publicControl(_ string, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errDenied
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !publicIP(ip) {
		return errDenied
	}
	return nil
}
func safeDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errDenied
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, errDenied
	}
	// Reject mixed answers, then pin literal addresses. The final socket guard
	// independently validates the address; no second DNS lookup can rebind it.
	for _, ip := range ips {
		if !publicIP(ip) {
			return nil, errDenied
		}
	}
	d := net.Dialer{Timeout: 10 * time.Second, Control: publicControl}
	for _, ip := range ips {
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, errDenied
		}
	}
	return nil, errDenied
}
func hostPort(host string, port int) string { return net.JoinHostPort(host, strconv.Itoa(port)) }
