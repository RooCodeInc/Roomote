package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/ironsh/iron-proxy/internal/transform"
)

type proxyPrincipalKey struct{}

func verifiedProxyPrincipal(r *http.Request) *transform.ProxyPrincipal {
	principal, _ := r.Context().Value(proxyPrincipalKey{}).(*transform.ProxyPrincipal)
	return principal
}

// ServeAuthenticatedProxy is a separate server-authenticated TLS listener.
// It never weakens the external-mTLS connector listener or fabricates a cert.
func (p *Proxy) ServeAuthenticatedProxy(ln net.Listener, cfg *tls.Config, authenticate func(context.Context, *http.Request) (*transform.ProxyPrincipal, error)) error {
	if cfg == nil || len(cfg.Certificates) == 0 || cfg.ClientAuth != tls.NoClientCert || authenticate == nil {
		return errors.New("authenticated proxy TLS required")
	}
	cfg = cfg.Clone()
	cfg.MinVersion = tls.VersionTLS12
	cfg.NextProtos = []string{"http/1.1"}
	p.httpServer.ReadHeaderTimeout = 10 * time.Second
	p.httpServer.IdleTimeout = 30 * time.Second
	p.httpServer.MaxHeaderBytes = 32 << 10
	p.httpServer.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.TLS == nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		principal, err := authenticate(r.Context(), r)
		if err != nil || principal == nil || !principal.ExpiresAt.After(time.Now()) {
			w.Header().Set("Proxy-Authenticate", `Basic realm="Session proxy"`)
			http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
			return
		}
		authRequest := r.Clone(r.Context())
		authRequest.Header = r.Header.Clone()
		r.Header.Del("Proxy-Authorization")
		watchCtx, cancel := context.WithDeadline(p.shutdownCtx, principal.ExpiresAt)
		defer cancel()
		guarded := &proxyAdmissionWriter{ResponseWriter: w, onHijack: func(conn net.Conn) {
			go func() {
				ticker := time.NewTicker(250 * time.Millisecond)
				defer ticker.Stop()
				defer conn.Close()
				for {
					select {
					case <-watchCtx.Done():
						return
					case <-ticker.C:
						current, err := authenticate(watchCtx, authRequest)
						if err != nil || current == nil || current.WorkloadID != principal.WorkloadID || current.SessionID != principal.SessionID || current.Generation != principal.Generation || current.ExpiresAt.Before(principal.ExpiresAt) {
							return
						}
					}
				}
			}()
		}}
		p.handleTunnelCONNECT(guarded, r.WithContext(context.WithValue(r.Context(), proxyPrincipalKey{}, principal)))
	})
	return p.httpServer.Serve(tls.NewListener(ln, cfg))
}

type proxyAdmissionWriter struct {
	http.ResponseWriter
	onHijack func(net.Conn)
}

func (w *proxyAdmissionWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijacking unavailable")
	}
	conn, buffer, err := hijacker.Hijack()
	if err == nil {
		w.onHijack(conn)
	}
	return conn, buffer, err
}

// ServeConnector uses Iron's CONNECT handler and inner TLS/certcache pipeline.
// No plaintext, SOCKS, direct-TLS or SNI passthrough listener is opened here.
func (p *Proxy) ServeConnector(ln net.Listener) error {
	if p.connectorTLS == nil || p.connectorTLS.ClientAuth != tls.RequireAndVerifyClientCert || p.connectorTLS.ClientCAs == nil {
		return errors.New("connector TLS required")
	}
	cfg := p.connectorTLS.Clone()
	cfg.NextProtos = []string{"http/1.1"}
	p.httpServer.ReadHeaderTimeout = 10 * time.Second
	p.httpServer.IdleTimeout = 30 * time.Second
	p.httpServer.MaxHeaderBytes = 32 << 10
	p.httpServer.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || verifiedConnectorCert(r) == nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		p.handleTunnelCONNECT(w, r)
	})
	return p.httpServer.Serve(tls.NewListener(ln, cfg))
}

func verifiedConnectorCert(r *http.Request) *x509.Certificate {
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 {
		return nil
	}
	return r.TLS.PeerCertificates[0]
}

type boundaryWriter struct {
	http.ResponseWriter
	check  func() error
	result *transform.PipelineResult
}

func (w *boundaryWriter) gate() {
	if w.check() != nil {
		w.abort()
	}
}
func (w *boundaryWriter) abort() {
	w.result.Action = transform.ActionReject
	w.result.Err = errors.New("response release denied")
	panic(http.ErrAbortHandler)
}
func (w *boundaryWriter) WriteHeader(code int)        { w.gate(); w.ResponseWriter.WriteHeader(code) }
func (w *boundaryWriter) Write(b []byte) (int, error) { w.gate(); return w.ResponseWriter.Write(b) }
func (w *boundaryWriter) Flush() {
	w.gate()
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil {
		w.abort()
	}
}
func abortProtected(w http.ResponseWriter) {
	if w, ok := w.(*boundaryWriter); ok {
		w.abort()
	}
}
