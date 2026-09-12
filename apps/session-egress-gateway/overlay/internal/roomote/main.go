package roomote

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ironsh/iron-proxy/internal/certcache"
	"github.com/ironsh/iron-proxy/internal/dnsguard"
	"github.com/ironsh/iron-proxy/internal/proxy"
	"github.com/ironsh/iron-proxy/internal/roomote/connector"
	"github.com/ironsh/iron-proxy/internal/transform"
)

func Main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println("roomote iron-proxy 2393dd175a8c419153fb49917fdeceb94cd9ed59")
		return
	}
	var err error
	if len(os.Args) == 2 && os.Args[1] == "connector" {
		err = runConnector(ctx)
	} else if len(os.Args) == 1 {
		err = runGateway(ctx)
	} else {
		err = errDenied
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "session egress startup or listener failed")
		os.Exit(1)
	}
}
func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
func roots(file string) (*x509.CertPool, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, errDenied
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(data) {
		return nil, errDenied
	}
	return pool, nil
}
func runGateway(ctx context.Context) error {
	// No settings that widen production egress or cache authorization decisions.
	for _, name := range []string{"SESSION_EGRESS_ALLOW_PASSTHROUGH", "SESSION_EGRESS_ALLOWED_PRIVATE_CIDRS", "SESSION_EGRESS_STREAM_AUTHORIZE_INTERVAL", "SESSION_EGRESS_UPSTREAM_CA_FILE", "SESSION_EGRESS_METRICS_ADDR"} {
		if os.Getenv(name) != "" {
			return errDenied
		}
	}
	timeout, err := time.ParseDuration(env("SESSION_EGRESS_AUTHORIZE_TIMEOUT", "2s"))
	if err != nil {
		return errDenied
	}
	client, err := newSecretClient(os.Getenv("SESSION_EGRESS_API_URL"), os.Getenv("SESSION_EGRESS_GATEWAY_TOKEN"), timeout)
	if err != nil {
		return err
	}
	max, err := strconv.ParseInt(env("SESSION_EGRESS_MAX_BUFFERED_RESPONSE_BYTES", "8388608"), 10, 64)
	if err != nil || max < 1 || max > 8<<20 {
		return errDenied
	}
	server, err := tls.LoadX509KeyPair(os.Getenv("SESSION_EGRESS_SERVER_CERT_FILE"), os.Getenv("SESSION_EGRESS_SERVER_KEY_FILE"))
	if err != nil {
		return errDenied
	}
	pool, err := roots(os.Getenv("SESSION_EGRESS_CLIENT_CA_FILE"))
	if err != nil {
		return err
	}
	cache, err := certcache.New(os.Getenv("SESSION_EGRESS_MITM_CA_CERT_FILE"), os.Getenv("SESSION_EGRESS_MITM_CA_KEY_FILE"), 512, 24*time.Hour)
	if err != nil {
		return errDenied
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	gate := &policy{client: client, maxBuffered: max, interval: 250 * time.Millisecond, logger: logger}
	pipeline := transform.NewPipeline([]transform.Transformer{gate}, transform.BodyLimits{}, quiet)
	guard, err := dnsguard.New(deniedCIDRs)
	if err != nil {
		return errDenied
	}
	p := proxy.New(proxy.Options{HTTPAddr: env("SESSION_EGRESS_LISTEN_ADDR", ":8443"), CertCache: cache, Pipeline: transform.NewPipelineHolder(pipeline), Guard: guard, UpstreamDialContext: safeDial, Logger: quiet,
		ExchangeRejected: func() {
			logger.Info("session_egress_final", "authorizationId", "", "workloadId", "", "outcome", "rejected")
		},
		ConnectorTLS: &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{server}, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert},
	})
	stopped := make(chan error, 1)
	go func() { stopped <- p.ListenAndServe() }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return p.Shutdown(shutdown)
	case err := <-stopped:
		return err
	}
}
func runConnector(ctx context.Context) error {
	cert, err := tls.LoadX509KeyPair(os.Getenv("SESSION_EGRESS_CONNECTOR_CERT_FILE"), os.Getenv("SESSION_EGRESS_CONNECTOR_KEY_FILE"))
	if err != nil {
		return errDenied
	}
	var pool *x509.CertPool
	if file := os.Getenv("SESSION_EGRESS_CONNECTOR_GATEWAY_CA_FILE"); file != "" {
		pool, err = roots(file)
		if err != nil {
			return err
		}
	}
	c, err := connector.New(connector.Options{GatewayAddr: os.Getenv("SESSION_EGRESS_CONNECTOR_GATEWAY_ADDR"), ClientCertificate: cert, GatewayRoots: pool, GatewayServerName: os.Getenv("SESSION_EGRESS_CONNECTOR_GATEWAY_SERVER_NAME")})
	if err != nil {
		return errDenied
	}
	server := c.Server()
	ln, err := net.Listen("tcp", env("SESSION_EGRESS_CONNECTOR_LISTEN_ADDR", ":3128"))
	if err != nil {
		return errDenied
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(ln) }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	case err := <-stopped:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}
