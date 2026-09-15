// Package connector implements the workload-side half of the session egress
// data plane: a plain HTTP CONNECT listener on the task network that relays
// each tunnel to the gateway over mTLS with the connector's own client
// certificate.
//
// The connector is what turns "a sandbox on network X" into an authenticated
// identity. It runs in its own container: the worker can reach its listener
// and nothing else about it. The client certificate and key live only in the
// connector's filesystem; the sandbox never sees them and cannot mint its own
// identity. The connector does not terminate TLS, look at request bytes, or
// hold any credential: it forwards the CONNECT authority to the gateway,
// which applies every rule (identity, authority binding, substitution,
// containment).
package connector

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ironsh/iron-proxy/internal/roomote/authority"
)

// Options configure a Connector.
type Options struct {
	// GatewayAddr is the gateway's mTLS CONNECT listener, host:port.
	GatewayAddr string
	// ClientCertificate is the controller-issued connector certificate
	// (SANs: connector identity URI + roomote://workload/<id>).
	ClientCertificate tls.Certificate
	// GatewayRoots verifies the gateway's server certificate (nil = system roots).
	GatewayRoots *x509.CertPool
	// GatewayServerName overrides the expected server name (default: host of GatewayAddr).
	GatewayServerName string
	// DialTimeout bounds TCP connect + TLS handshake + the CONNECT round trip (default 10s).
	DialTimeout time.Duration
	// Logger receives operational lines only (never authorities or bytes). nil = std logger.
	Logger *log.Logger
	// DialContext overrides the network dialer (tests).
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
}

// Metrics are cheap counters exposed for tests and diagnostics.
type Metrics struct {
	Connects         atomic.Int64
	RejectedRequests atomic.Int64
	GatewayRefusals  atomic.Int64
	GatewayErrors    atomic.Int64
	Relayed          atomic.Int64
}

// Connector is the plain-CONNECT relay. Construct with New.
type Connector struct {
	gatewayAddr string
	tlsConfig   *tls.Config
	dialTimeout time.Duration
	dial        func(ctx context.Context, network, addr string) (net.Conn, error)
	logger      *log.Logger

	Metrics Metrics
}

// New validates options and builds a connector.
func New(opts Options) (*Connector, error) {
	host, port, err := net.SplitHostPort(opts.GatewayAddr)
	if err != nil || host == "" {
		return nil, errors.New("connector: GatewayAddr must be host:port")
	}
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return nil, errors.New("connector: GatewayAddr port out of range")
	}
	if len(opts.ClientCertificate.Certificate) == 0 || opts.ClientCertificate.PrivateKey == nil {
		return nil, errors.New("connector: ClientCertificate is required")
	}
	serverName := opts.GatewayServerName
	if serverName == "" {
		serverName = host
	}
	c := &Connector{
		gatewayAddr: opts.GatewayAddr,
		tlsConfig: &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{opts.ClientCertificate},
			RootCAs:      opts.GatewayRoots,
			ServerName:   serverName,
			NextProtos:   []string{"http/1.1"},
		},
		dialTimeout: opts.DialTimeout,
		dial:        opts.DialContext,
		logger:      opts.Logger,
	}
	if c.dialTimeout <= 0 {
		c.dialTimeout = 10 * time.Second
	}
	if c.dial == nil {
		c.dial = (&net.Dialer{}).DialContext
	}
	if c.logger == nil {
		c.logger = log.Default()
	}
	return c, nil
}

// Server returns an HTTP/1.1 server that serves the connector.
func (c *Connector) Server() *http.Server {
	return &http.Server{
		Handler:           c,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          c.logger,
	}
}

// Listen opens the plaintext listener. Bind it to the workload network only.
func (c *Connector) Listen(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}

// ServeHTTP accepts CONNECT only. Everything else is refused: the connector is
// not a general proxy, and plain `http://` targets have no place in a
// contract that only ever substitutes credentials inside HTTPS.
func (c *Connector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		c.Metrics.RejectedRequests.Add(1)
		w.Header().Set("Allow", http.MethodConnect)
		w.Header().Set("Connection", "close")
		http.Error(w, "session egress connector accepts CONNECT only", http.StatusMethodNotAllowed)
		return
	}
	c.Metrics.Connects.Add(1)

	host, port, ok := authority.Parse(r.RequestURI, r.Host)
	if !ok {
		c.Metrics.RejectedRequests.Add(1)
		http.Error(w, "invalid CONNECT authority", http.StatusBadRequest)
		return
	}
	target := net.JoinHostPort(host, strconv.Itoa(port))

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		c.Metrics.GatewayErrors.Add(1)
		http.Error(w, "connector cannot relay on this connection", http.StatusInternalServerError)
		return
	}

	// Establish the gateway tunnel before answering the client so a refusal
	// is reported as a proxy status rather than a torn-down tunnel.
	ctx, cancel := context.WithTimeout(r.Context(), c.dialTimeout)
	gw, gwReader, status, err := c.openGatewayTunnel(ctx, target)
	cancel()
	if err != nil {
		c.Metrics.GatewayErrors.Add(1)
		c.logger.Printf("session-egress-connector: gateway tunnel failed with error class %T", err)
		http.Error(w, "session egress gateway unavailable", http.StatusBadGateway)
		return
	}
	if status != http.StatusOK {
		gw.Close()
		c.Metrics.GatewayRefusals.Add(1)
		http.Error(w, "session egress gateway refused the tunnel", mapGatewayStatus(status))
		return
	}

	client, clientBuf, err := hijacker.Hijack()
	if err != nil {
		gw.Close()
		c.Metrics.GatewayErrors.Add(1)
		return
	}
	if _, err := clientBuf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		client.Close()
		gw.Close()
		return
	}
	if err := clientBuf.Flush(); err != nil {
		client.Close()
		gw.Close()
		return
	}
	c.Metrics.Relayed.Add(1)

	// Bytes either side already buffered belong to the tunnel; replay them.
	var clientSide io.Reader = client
	if clientBuf.Reader.Buffered() > 0 {
		clientSide = io.MultiReader(io.LimitReader(clientBuf.Reader, int64(clientBuf.Reader.Buffered())), client)
	}
	var gatewaySide io.Reader = gw
	if gwReader.Buffered() > 0 {
		gatewaySide = io.MultiReader(io.LimitReader(gwReader, int64(gwReader.Buffered())), gw)
	}
	relay(client, clientSide, gw, gatewaySide)
}

// openGatewayTunnel dials the gateway with mTLS and issues the CONNECT.
// It returns the connection, a reader positioned after the response, and the
// gateway's status code.
func (c *Connector) openGatewayTunnel(ctx context.Context, target string) (net.Conn, *bufio.Reader, int, error) {
	raw, err := c.dial(ctx, "tcp", c.gatewayAddr)
	if err != nil {
		return nil, nil, 0, err
	}
	tlsConn := tls.Client(raw, c.tlsConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, nil, 0, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = tlsConn.SetDeadline(deadline)
	}
	req := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Host: target},
		Host:   target,
		Header: http.Header{},
	}
	if _, err := io.WriteString(tlsConn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n"); err != nil {
		tlsConn.Close()
		return nil, nil, 0, err
	}
	reader := bufio.NewReader(tlsConn)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		tlsConn.Close()
		return nil, nil, 0, err
	}
	// Drain any body on a refusal so the response is fully consumed; on 200
	// there is no body by definition and the tunnel bytes stay in `reader`.
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	}
	resp.Body.Close()
	_ = tlsConn.SetDeadline(time.Time{})
	return tlsConn, reader, resp.StatusCode, nil
}

func mapGatewayStatus(status int) int {
	switch status {
	case http.StatusForbidden, http.StatusBadRequest, http.StatusNotImplemented, http.StatusMethodNotAllowed:
		return status
	default:
		return http.StatusBadGateway
	}
}

// relay copies both directions until either side ends, then closes both.
func relay(client net.Conn, fromClient io.Reader, gateway net.Conn, fromGateway io.Reader) {
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			client.Close()
			gateway.Close()
		})
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(gateway, fromClient)
		closeWrite(gateway)
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(client, fromGateway)
		closeWrite(client)
	}()
	wg.Wait()
	closeBoth()
}

func closeWrite(conn net.Conn) {
	if cw, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	// Half-close is unavailable (e.g. TLS): a full close is the only way to
	// signal EOF, and the other direction will observe it and finish.
	_ = conn.Close()
}
