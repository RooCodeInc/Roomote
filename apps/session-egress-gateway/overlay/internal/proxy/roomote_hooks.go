package proxy

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/ironsh/iron-proxy/internal/transform"
)

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
