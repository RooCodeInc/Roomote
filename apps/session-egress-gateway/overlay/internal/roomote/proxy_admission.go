package roomote

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/ironsh/iron-proxy/internal/roomote/authority"
	"github.com/ironsh/iron-proxy/internal/roomote/identity"
	"github.com/ironsh/iron-proxy/internal/transform"
)

var proxyCapabilityPattern = regexp.MustCompile(`^rproxy_[A-Za-z0-9_-]{43}$`)

func proxyCapability(req *http.Request) (string, error) {
	values := req.Header.Values("Proxy-Authorization")
	if len(values) != 1 || len(values[0]) > 256 {
		return "", errDenied
	}
	scheme, encoded, ok := strings.Cut(values[0], " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return "", errDenied
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return "", errDenied
	}
	user, token, ok := strings.Cut(string(decoded), ":")
	if !ok || user != "workload" || !proxyCapabilityPattern.MatchString(token) {
		return "", errDenied
	}
	return token, nil
}

func (c *secretClient) authenticateProxyConnect(ctx context.Context, req *http.Request) (*transform.ProxyPrincipal, error) {
	if req.Method != http.MethodConnect {
		return nil, errDenied
	}
	token, err := proxyCapability(req)
	if err != nil {
		return nil, errDenied
	}
	host, port, ok := authority.Parse(req.RequestURI, req.Host)
	if !ok {
		return nil, errDenied
	}
	data, err := json.Marshal(struct {
		ProxyCapability string      `json:"proxyCapability"`
		Destination     destination `json:"destination"`
	}{token, destination{host, port}})
	if err != nil {
		return nil, errDenied
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(c.url, "/authorize")+"/proxy-connect", bytes.NewReader(data))
	if err != nil {
		return nil, errDenied
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return nil, errDenied
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errDenied
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(data) > 4096 {
		return nil, errDenied
	}
	var result struct {
		Allowed    bool      `json:"allowed"`
		WorkloadID string    `json:"workloadId"`
		SessionID  string    `json:"sessionId"`
		Generation int       `json:"generation"`
		ExpiresAt  time.Time `json:"expiresAt"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF || !result.Allowed ||
		!identity.IsUUID(result.WorkloadID) || !identity.IsUUID(result.SessionID) || result.Generation < 1 || !result.ExpiresAt.After(time.Now()) {
		return nil, errDenied
	}
	return &transform.ProxyPrincipal{WorkloadID: result.WorkloadID, SessionID: result.SessionID,
		Generation: result.Generation, ExpiresAt: result.ExpiresAt, Capability: token}, nil
}
