package roomote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/ironsh/iron-proxy/internal/roomote/identity"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var errDenied = errors.New("session egress denied")

type destination struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}
type authorizationRequest struct {
	WorkloadID        string      `json:"workloadId"`
	ConnectorIdentity string      `json:"connectorIdentity"`
	Substitute        string      `json:"substitute"`
	Destination       destination `json:"destination"`
	Method            string      `json:"method"`
	Path              string      `json:"path"`
	Phase             string      `json:"phase"`
	AuthorizationID   string      `json:"authorizationId,omitempty"`
}
type credential struct {
	HeaderName   string `json:"headerName"`
	HeaderPrefix string `json:"headerPrefix"`
	Value        string `json:"value"`
}
type authorization struct {
	Allowed         bool        `json:"allowed"`
	AuthorizationID string      `json:"authorizationId"`
	WorkloadID      string      `json:"workloadId"`
	Generation      int         `json:"generation"`
	SessionID       string      `json:"sessionId"`
	SecretRef       string      `json:"secretRef"`
	ExpiresAt       time.Time   `json:"expiresAt"`
	Credential      *credential `json:"credential,omitempty"`
	Reason          string      `json:"reason,omitempty"`
}

// secretClient carries only the dedicated gateway API token. It cannot accept
// customer credentials, job-signing keys, alternate endpoints or proxy config.
type secretClient struct {
	url, token string
	client     *http.Client
}

func newSecretClient(origin, token string, timeout time.Duration) (*secretClient, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || len(token) < 32 || strings.ContainsAny(token, "\r\n") || timeout <= 0 || timeout > 5*time.Second {
		return nil, errDenied
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	return &secretClient{url: strings.TrimSuffix(origin, "/") + "/api/internal/session-egress/authorize", token: token, client: &http.Client{
		Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}
func (c *secretClient) authorize(ctx context.Context, input authorizationRequest) (authorization, error) {
	var out authorization
	data, err := json.Marshal(input)
	if err != nil {
		return out, errDenied
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(data))
	if err != nil {
		return out, errDenied
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return out, errDenied
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, errDenied
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, (32<<10)+1))
	if err != nil || len(data) > 32<<10 {
		return out, errDenied
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(&out) != nil || dec.Decode(new(any)) != io.EOF || !out.Allowed || out.WorkloadID != input.WorkloadID || !out.ExpiresAt.After(time.Now()) || out.AuthorizationID == "" || out.Generation < 1 {
		return authorization{}, errDenied
	}
	if !identity.IsUUID(out.AuthorizationID) || !identity.IsUUID(out.WorkloadID) || !identity.IsUUID(out.SessionID) || !identity.IsUUID(out.SecretRef) || (input.AuthorizationID != "" && input.AuthorizationID != out.AuthorizationID) {
		return authorization{}, errDenied
	}
	if input.Phase == "request" {
		if out.Credential == nil || out.Credential.Value == "" || len(out.Credential.Value) > 8192 || strings.ContainsAny(out.Credential.Value, "\r\n\x00") {
			return authorization{}, errDenied
		}
	} else if out.Credential != nil {
		return authorization{}, errDenied
	}
	return out, nil
}
