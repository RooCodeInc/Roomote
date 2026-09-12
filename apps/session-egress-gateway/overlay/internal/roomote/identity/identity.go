// Package identity derives the connector identity and workload binding from
// the connector's mTLS client certificate.
//
// Nothing a sandbox sends inside the tunnel is authority. The two values the
// control plane needs on every /authorize call — connectorIdentity and
// workloadId — therefore come exclusively from the certificate the connector
// presented during the outer TLS handshake, which the trusted controller
// provisions outside the sandbox.
package identity

import (
	"crypto/x509"
	"errors"
	"net/url"
	"strings"
)

// WorkloadURIScheme is the SAN URI scheme that carries the workload binding:
// `roomote://workload/<uuid>`.
const WorkloadURIScheme = "roomote"

const workloadURIHost = "workload"

// ErrNoWorkload is returned when the certificate does not carry exactly one
// `roomote://workload/<uuid>` SAN URI.
var ErrNoWorkload = errors.New("identity: certificate does not bind a workload")

// ErrNoConnectorIdentity is returned without one unambiguous SPIFFE SAN URI.
var ErrNoConnectorIdentity = errors.New("identity: certificate does not carry a connector identity")

// Identity is the authenticated principal behind a CONNECT tunnel.
type Identity struct {
	// ConnectorIdentity is the value the controller registered with
	// POST /workloads (16–512 printable ASCII chars).
	ConnectorIdentity string
	// WorkloadID is the UUID from the `roomote://workload/<uuid>` SAN URI.
	WorkloadID string
}

// FromCertificate extracts the identity from a verified client certificate.
//
// Rules:
//   - exactly one SAN URI with scheme `roomote` and host `workload` whose path
//     is a UUID supplies WorkloadID; zero or more than one is a rejection;
//   - exactly one other URI, with scheme spiffe, is the connector identity;
//     subject CNs, ambiguous SANs, query strings and fragments are rejected;
//   - the connector identity must be 16–512 printable ASCII characters
//     (matching the control plane's connectorIdentitySchema).
func FromCertificate(cert *x509.Certificate) (Identity, error) {
	if cert == nil {
		return Identity{}, ErrNoConnectorIdentity
	}

	var (
		workloadID string
		workloads  int
		connector  string
	)
	for _, u := range cert.URIs {
		if u == nil {
			continue
		}
		if strings.EqualFold(u.Scheme, WorkloadURIScheme) {
			workloads++
			if id, ok := workloadIDFromURI(u); ok {
				workloadID = id
			}
			continue
		}
		if connector != "" || u.Scheme != "spiffe" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return Identity{}, ErrNoConnectorIdentity
		}
		connector = u.String()
	}
	if workloads != 1 || workloadID == "" {
		return Identity{}, ErrNoWorkload
	}
	if !ValidConnectorIdentity(connector) {
		return Identity{}, ErrNoConnectorIdentity
	}
	return Identity{ConnectorIdentity: connector, WorkloadID: workloadID}, nil
}

func workloadIDFromURI(u *url.URL) (string, bool) {
	if !strings.EqualFold(u.Host, workloadURIHost) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	id := strings.TrimPrefix(u.Path, "/")
	if !IsUUID(id) {
		return "", false
	}
	return strings.ToLower(id), true
}

// ValidConnectorIdentity mirrors connectorIdentitySchema: 16–512 chars, each in
// the printable ASCII range 0x21–0x7e (no spaces).
func ValidConnectorIdentity(s string) bool {
	if len(s) < 16 || len(s) > 512 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

// IsUUID reports whether s is a canonical 8-4-4-4-12 hexadecimal UUID.
func IsUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}
