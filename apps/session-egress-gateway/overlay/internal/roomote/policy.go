package roomote

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ironsh/iron-proxy/internal/roomote/authority"
	"github.com/ironsh/iron-proxy/internal/roomote/echo"
	"github.com/ironsh/iron-proxy/internal/roomote/identity"
	"github.com/ironsh/iron-proxy/internal/transform"
)

type policy struct {
	client      *secretClient
	maxBuffered int64
	interval    time.Duration
	logger      *slog.Logger
}
type exchangeKey struct{}
type exchange struct {
	policy   *policy
	request  authorizationRequest
	grant    authorization
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	scanner  *echo.Scanner
	failed   atomic.Bool
	complete atomic.Bool
	checkMu  sync.Mutex
}

func (*policy) Name() string { return "roomote-session-egress" }
func reject() (*transform.TransformResult, error) {
	return &transform.TransformResult{Action: transform.ActionReject}, nil
}
func proceed() (*transform.TransformResult, error) {
	return &transform.TransformResult{Action: transform.ActionContinue}, nil
}

var tokenPattern = regexp.MustCompile(`^rses_[A-Za-z0-9_-]{32,123}$`)

func (p *policy) TransformRequest(ctx context.Context, tc *transform.TransformContext, req *http.Request) (*transform.TransformResult, error) {
	var s *exchange
	var input authorizationRequest
	if req.Method != http.MethodConnect || tc.Tunnel != nil {
		var once sync.Once
		tc.Finalize = func(result *transform.PipelineResult) {
			once.Do(func() {
				outcome := "rejected"
				if s != nil {
					// Serialize the terminal decision with idle authorization checks.
					s.checkMu.Lock()
					if s.ctx.Err() != nil {
						outcome = "canceled"
					} else if s.complete.Load() && !s.failed.Load() && result.Err == nil && result.Action == transform.ActionContinue {
						outcome = "forwarded"
					}
					s.cancel()
					s.checkMu.Unlock()
					<-s.done
					s.scanner = nil
				} else if ctx.Err() != nil {
					outcome = "canceled"
				}
				p.logger.Info("session_egress_final", "authorizationId", input.AuthorizationID, "workloadId", input.WorkloadID, "outcome", outcome)
			})
		}
	}
	principal, err := identity.FromCertificate(tc.ClientCert)
	if err != nil || tc.Mode != transform.ModeMITM || !tc.ClientCert.NotAfter.After(time.Now()) {
		return reject()
	}
	if req.Method == http.MethodConnect {
		// Admission authenticates the connector and validates authority, not a grant.
		// The substitute belongs exclusively to an inner approved header position.
		if tc.Tunnel != nil {
			return reject()
		}
		host, port, ok := authority.Parse(req.Host, req.Host)
		if !ok || req.Host != hostPort(host, port) {
			return reject()
		}
		return proceed()
	}
	if tc.Tunnel == nil || req.TLS == nil {
		return reject()
	}
	input.WorkloadID = principal.WorkloadID
	host, port, ok := authority.Parse(tc.Tunnel.Target, tc.Tunnel.Target)
	if !ok || tc.SNI != host || !authority.HostMatches(req.Host, host, port) || (req.URL.IsAbs() && (req.URL.Scheme != "https" || !authority.HostMatches(req.URL.Host, host, port))) {
		return reject()
	}
	switch req.Method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE":
	default:
		return reject()
	}
	if req.Header.Get("Upgrade") != "" || len(req.Trailer) > 0 || strings.HasPrefix(strings.ToLower(req.Header.Get("Content-Type")), "application/grpc") {
		return reject()
	}
	var slot, prefix, token string
	for _, name := range []string{"authorization", "x-api-key", "api-key"} {
		values := req.Header.Values(name)
		if len(values) == 0 {
			continue
		}
		if len(values) != 1 || slot != "" {
			return reject()
		}
		value := values[0]
		for _, candidate := range []string{"Bearer ", "Basic ", "Token "} {
			if len(value) >= len(candidate) && strings.EqualFold(value[:len(candidate)], candidate) {
				prefix = candidate
				value = value[len(candidate):]
				break
			}
		}
		if !tokenPattern.MatchString(value) {
			return reject()
		}
		slot, token = name, value
	}
	if slot == "" {
		return reject()
	}
	// Never discover or substitute a token in a path, query, arbitrary header or body.
	// Other fields do not contribute authority; bodies pass through byte-exact.
	input = authorizationRequest{WorkloadID: principal.WorkloadID, ConnectorIdentity: principal.ConnectorIdentity, Substitute: token, Destination: destination{host, port}, Method: req.Method, Path: req.URL.RequestURI(), Phase: "request"}
	grant, err := p.client.authorize(ctx, input)
	if err != nil {
		return reject()
	}
	input.AuthorizationID = grant.AuthorizationID
	c := grant.Credential
	if c.HeaderName != slot || c.HeaderPrefix != prefix {
		return reject()
	}
	deadline := grant.ExpiresAt
	if tc.ClientCert.NotAfter.Before(deadline) {
		deadline = tc.ClientCert.NotAfter
	}
	live, cancel := context.WithDeadline(ctx, deadline)
	s = &exchange{policy: p, request: input, grant: grant, ctx: live, cancel: cancel, done: make(chan struct{}), scanner: echo.New(c.Value)}
	s.grant.Credential = nil
	*req = *req.WithContext(context.WithValue(live, exchangeKey{}, s))
	go s.watch()
	for name := range req.Header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "proxy-") || strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" || lower == "via" || lower == "x-real-ip" || lower == "connection" {
			req.Header.Del(name)
		}
	}
	for _, name := range []string{"authorization", "x-api-key", "api-key"} {
		req.Header.Del(name)
	}
	req.Header.Set(slot, c.HeaderPrefix+c.Value)
	req.Header.Set("Accept-Encoding", "identity")
	return proceed()
}
func (s *exchange) check(phase string) error {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	if s.ctx.Err() != nil || s.failed.Load() {
		return errDenied
	}
	req := s.request
	req.Phase = phase
	grant, err := s.policy.client.authorize(s.ctx, req)
	if err != nil || grant.Generation != s.grant.Generation || grant.SessionID != s.grant.SessionID || grant.SecretRef != s.grant.SecretRef || grant.ExpiresAt.Before(s.grant.ExpiresAt) {
		s.failed.Store(true)
		s.cancel()
		return errDenied
	}
	// Renewals may extend live authorization, but never the exchange's original
	// context deadline. Remember the latest expiry so any shortening fails closed.
	s.grant.ExpiresAt = grant.ExpiresAt
	return nil
}
func (s *exchange) watch() {
	defer close(s.done)
	ticker := time.NewTicker(s.policy.interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			if s.check("stream") != nil {
				return
			}
		}
	}
}
func (p *policy) TransformResponse(ctx context.Context, tc *transform.TransformContext, req *http.Request, resp *http.Response) (*transform.TransformResult, error) {
	s, ok := req.Context().Value(exchangeKey{}).(*exchange)
	if !ok {
		return reject()
	}
	// The request header must not remain a credential-bearing object downstream.
	for _, name := range []string{"authorization", "x-api-key", "api-key"} {
		req.Header.Del(name)
	}
	if headerEcho(s.scanner, resp.Header) || (resp.Header.Get("Content-Encoding") != "" && resp.Header.Get("Content-Encoding") != "identity") || resp.StatusCode == 101 {
		s.failed.Store(true)
		return reject()
	}
	body := transform.RequireBufferedBody(resp.Body).StreamingReader()
	for _, name := range []string{"Connection", "Proxy-Authenticate", "Transfer-Encoding", "Trailer", "Location", "Alt-Svc"} {
		resp.Header.Del(name)
	}
	trailer := func() http.Header { return resp.Trailer }
	if resp.ContentLength >= 0 && resp.ContentLength <= p.maxBuffered && !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		data, err := io.ReadAll(io.LimitReader(body, p.maxBuffered+1))
		if err != nil || int64(len(data)) > p.maxBuffered || s.scanner.Contains(data) || headerEcho(s.scanner, trailer()) {
			s.failed.Store(true)
			return reject()
		}
		if s.check("response") != nil {
			return reject()
		}
		resp.Body = transform.NewBufferedBodyFromBytes(data)
		s.complete.Store(true)
	} else {
		if s.check("response") != nil {
			return reject()
		}
		// No BufferedBody.Read: Iron's upstream limit truncates silently. A bounded
		// holdback reader consumes the original stream without any total-size cap.
		safe := &echoReader{source: body, stream: s.scanner.NewStream(), exchange: s, trailer: trailer}
		resp.Body = transform.NewBufferedBody(io.NopCloser(safe), 0)
	}
	tc.BeforeWrite = func() error { return s.check("stream") }
	tc.WriteContext = s.ctx
	return proceed()
}
func headerEcho(scanner *echo.Scanner, h http.Header) bool {
	total := 0
	for k, values := range h {
		total += len(k)
		if scanner.ContainsString(k) {
			return true
		}
		for _, v := range values {
			total += len(v)
			if total > 64<<10 || scanner.ContainsString(v) {
				return true
			}
		}
	}
	return false
}

type echoReader struct {
	source   io.Reader
	stream   *echo.Stream
	exchange *exchange
	trailer  func() http.Header
	pending  []byte
	ended    bool
}

func (r *echoReader) Read(dst []byte) (int, error) {
	if len(dst) == 0 {
		return 0, nil
	}
	for len(r.pending) == 0 && !r.ended {
		buf := make([]byte, 32<<10)
		n, err := r.source.Read(buf)
		if r.exchange.ctx.Err() != nil {
			r.exchange.failed.Store(true)
			return 0, errDenied
		}
		safe, scanErr := r.stream.Feed(buf[:n])
		if scanErr != nil || (err != nil && err != io.EOF) {
			r.exchange.failed.Store(true)
			return 0, errDenied
		}
		if err == io.EOF {
			if headerEcho(r.exchange.scanner, r.trailer()) || r.exchange.check("stream") != nil {
				r.exchange.failed.Store(true)
				return 0, errDenied
			}
			tail, flushErr := r.stream.Flush()
			if flushErr != nil {
				r.exchange.failed.Store(true)
				return 0, errDenied
			}
			safe = append(safe, tail...)
			r.ended = true
			r.exchange.complete.Store(true)
		}
		r.pending = safe
	}
	if len(r.pending) > 0 {
		n := copy(dst, r.pending)
		r.pending = r.pending[n:]
		return n, nil
	}
	return 0, io.EOF
}
