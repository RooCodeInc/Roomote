package transform

import "time"

// ProxyPrincipal is installed only after authenticated CONNECT admission.
// It represents transferable capability possession, not physical workload origin.
type ProxyPrincipal struct {
	WorkloadID string
	SessionID  string
	Generation int
	ExpiresAt  time.Time
	Capability string
}
