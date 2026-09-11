package roomote

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ironsh/iron-proxy/internal/certcache"
	"github.com/ironsh/iron-proxy/internal/proxy"
	"github.com/ironsh/iron-proxy/internal/roomote/identity"
	"github.com/ironsh/iron-proxy/internal/transform"
	"github.com/stretchr/testify/require"
)

const workload = "11111111-1111-4111-8111-111111111111"
const otherWorkload = "22222222-2222-4222-8222-222222222222"
const connectorID = "spiffe://roomote/connector/local-fixture"
const substitute = "rses_0123456789abcdefghijklmnopqrstuvwxyz0123456789"
const realKey = "FixtureSecret_ABC123+/%xy987654321"
const authID = "33333333-3333-4333-8333-333333333333"

type pki struct {
	cert              *x509.Certificate
	key               *ecdsa.PrivateKey
	pool              *x509.CertPool
	certFile, keyFile string
}

func newPKI(t *testing.T) *pki {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "local fixture CA"}, IsCA: true, BasicConstraintsValid: true, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	require.NoError(t, err)
	cert, err := x509.ParseCertificate(der)
	require.NoError(t, err)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	dir := t.TempDir()
	cp, kp := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "ca.key")
	require.NoError(t, os.WriteFile(cp, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600))
	kd, err := x509.MarshalECPrivateKey(key)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(kp, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd}), 0600))
	return &pki{cert, key, pool, cp, kp}
}
func (p *pki) leaf(t *testing.T, uris []string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	require.NoError(t, err)
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "fixture"}, DNSNames: []string{"upstream.test", "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	for _, raw := range uris {
		u, err := url.Parse(raw)
		require.NoError(t, err)
		template.URIs = append(template.URIs, u)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, p.cert, &key.PublicKey, p.key)
	require.NoError(t, err)
	return tls.Certificate{Certificate: [][]byte{der, p.cert.Raw}, PrivateKey: key}
}

type fixture struct {
	t               *testing.T
	pki             *pki
	p               *proxy.Proxy
	target, addr    string
	client          *http.Client
	connectorCert   tls.Certificate
	revoked, outage atomic.Bool
	denyResponse    atomic.Bool
	hits            atomic.Int64
	phaseMu         sync.Mutex
	phases          []string
	expiry          time.Time
	api             *httptest.Server
	logs            logBuffer
}

type logBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}

func (b *logBuffer) snapshot() string {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.String()
}

func (f *fixture) assertFinal(outcome, authorizationID string) {
	f.t.Helper()
	require.Eventually(f.t, func() bool { return strings.Contains(f.logs.snapshot(), "session_egress_final") }, time.Second, time.Millisecond)
	require.Never(f.t, func() bool { return strings.Count(f.logs.snapshot(), "\n") != 1 }, 100*time.Millisecond, time.Millisecond)
	var event map[string]any
	require.NoError(f.t, json.Unmarshal([]byte(f.logs.snapshot()), &event))
	require.Equal(f.t, "session_egress_final", event["msg"])
	require.Equal(f.t, outcome, event["outcome"])
	require.Equal(f.t, authorizationID, event["authorizationId"])
	require.Equal(f.t, workload, event["workloadId"])
	require.Len(f.t, event, 6, "only time, level, message and three bounded outcome fields")
	for _, sensitive := range []string{substitute, realKey, "private-path", "private-query", "private-body", strings.Repeat("g", 32), "upstreamerr"} {
		require.NotContains(f.t, f.logs.snapshot(), sensitive)
	}
}

func newFixture(t *testing.T, handler http.HandlerFunc) *fixture {
	t.Helper()
	f := &fixture{t: t, pki: newPKI(t), expiry: time.Now().Add(time.Minute).Truncate(time.Second)}
	f.connectorCert = f.pki.leaf(t, []string{connectorID, "roomote://workload/" + workload})
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.hits.Add(1); handler(w, r) }))
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{f.pki.leaf(t, nil)}, MinVersion: tls.VersionTLS12}
	upstream.StartTLS()
	t.Cleanup(upstream.Close)
	_, port, err := net.SplitHostPort(upstream.Listener.Addr().String())
	require.NoError(t, err)
	f.target = "upstream.test:" + port
	f.api = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.outage.Load() {
			http.Error(w, "unavailable", 503)
			return
		}
		if r.URL.Path != "/api/internal/session-egress/authorize" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("g", 32) {
			http.Error(w, "unauthorized", 401)
			return
		}
		var input authorizationRequest
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			http.Error(w, "malformed", 400)
			return
		}
		f.phaseMu.Lock()
		f.phases = append(f.phases, input.Phase)
		f.phaseMu.Unlock()
		if f.revoked.Load() || (f.denyResponse.Load() && input.Phase == "response") || input.WorkloadID != workload || input.ConnectorIdentity != connectorID || input.Substitute != substitute || hostPort(input.Destination.Host, input.Destination.Port) != f.target {
			_ = json.NewEncoder(w).Encode(map[string]any{"allowed": false, "reason": "workload_mismatch"})
			return // Fixture writer errors are client disconnects.
		}
		grant := authorization{Allowed: true, AuthorizationID: authID, WorkloadID: workload, Generation: 1, SessionID: otherWorkload, SecretRef: otherWorkload, ExpiresAt: f.expiry}
		if input.Phase == "request" {
			grant.Credential = &credential{"authorization", "Bearer ", realKey}
		}
		_ = json.NewEncoder(w).Encode(grant) // Fixture writer errors are client disconnects.
	}))
	t.Cleanup(f.api.Close)
	secret, err := newSecretClient(f.api.URL, strings.Repeat("g", 32), time.Second)
	require.NoError(t, err)
	secret.client.Transport = f.api.Client().Transport
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	gate := &policy{client: secret, maxBuffered: 1024, interval: 30 * time.Millisecond, logger: slog.New(slog.NewJSONHandler(&f.logs, nil))}
	pipeline := transform.NewPipeline([]transform.Transformer{gate}, transform.BodyLimits{MaxRequestBodyBytes: 1, MaxResponseBodyBytes: 1}, quiet)
	cache, err := certcache.New(f.pki.certFile, f.pki.keyFile, 32, time.Hour)
	require.NoError(t, err)
	f.p = proxy.New(proxy.Options{CertCache: cache, Pipeline: transform.NewPipelineHolder(pipeline), Logger: quiet, UpstreamRootCAs: f.pki.pool,
		ExchangeRejected: func() {
			gate.logger.Info("session_egress_final", "authorizationId", "", "workloadId", "", "outcome", "rejected")
		},
		UpstreamDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != f.target {
				return nil, errDenied
			}
			return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
		}, ConnectorTLS: &tls.Config{Certificates: []tls.Certificate{f.pki.leaf(t, nil)}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: f.pki.pool, MinVersion: tls.VersionTLS13},
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	f.addr = ln.Addr().String()
	go func() { _ = f.p.ServeConnector(ln) }() // Shutdown is asserted by cleanup.
	f.client = f.httpClient(f.connectorCert)
	t.Cleanup(func() {
		f.client.CloseIdleConnections()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		require.NoError(t, f.p.Shutdown(ctx))
	})
	return f
}
func (f *fixture) httpClient(cert tls.Certificate) *http.Client {
	proxyURL, err := url.Parse("https://" + f.addr)
	require.NoError(f.t, err)
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: f.pki.pool, Certificates: []tls.Certificate{cert}}, DisableCompression: true}, Timeout: 4 * time.Second}
}
func (f *fixture) request(method, path string, body io.Reader) *http.Request {
	req, err := http.NewRequest(method, "https://"+f.target+path, body)
	require.NoError(f.t, err)
	req.Header.Set("Authorization", "Bearer "+substitute)
	return req
}
func TestIronPOSTAndNullBody(t *testing.T) {
	for _, payload := range []string{"", `{"arbitrary":"preserved POST bytes rses_body_is_not_authority"}`, "null"} {
		t.Run(payload, func(t *testing.T) {
			observed := make(chan string, 1)
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+realKey {
					http.Error(w, "bad injection", 500)
					return
				}
				data, err := io.ReadAll(r.Body)
				if err != nil {
					http.Error(w, "read failure", 500)
					return
				}
				observed <- string(data)
				w.Header().Set("Content-Length", "2")
				_, _ = w.Write([]byte("ok")) // Fixture write errors only indicate a disconnected client.
			})
			var body io.Reader
			if payload != "" {
				body = strings.NewReader(payload)
			}
			resp, err := f.client.Do(f.request("POST", "/write", body))
			require.NoError(t, err)
			defer resp.Body.Close()
			data, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			require.Equal(t, 200, resp.StatusCode)
			require.Equal(t, "ok", string(data))
			require.Equal(t, payload, <-observed)
			f.phaseMu.Lock()
			require.Contains(t, f.phases, "request")
			require.Contains(t, f.phases, "response")
			require.Contains(t, f.phases, "stream")
			f.phaseMu.Unlock()
		})
	}
}
func TestIronReflectionDenied(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("prefix:" + realKey + ":suffix"))
	cases := []struct{ name, value string }{{"literal", realKey}, {"base64", encoded}, {"percent", url.QueryEscape(realKey)}}
	for _, tc := range cases {
		for _, surface := range []string{"header", "body", "trailer", "stream"} {
			t.Run(tc.name+"/"+surface, func(t *testing.T) {
				f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
					switch surface {
					case "header":
						w.Header().Set("X-Reflected", tc.value)
					case "body":
						w.Header().Set("Content-Length", fmt.Sprint(len(tc.value)))
						_, _ = io.WriteString(w, tc.value)
						return // Fixture disconnects are expected.
					case "trailer":
						w.Header().Set("Trailer", "X-Reflected")
						w.WriteHeader(200)
						_, _ = io.WriteString(w, "safe\n")
						w.Header().Set("X-Reflected", tc.value)
						return
					case "stream":
						w.Header().Set("Content-Type", "text/event-stream")
						w.WriteHeader(200)
						_, _ = io.WriteString(w, tc.value[:len(tc.value)/2])
						w.(http.Flusher).Flush()
						time.Sleep(10 * time.Millisecond)
						_, _ = io.WriteString(w, tc.value[len(tc.value)/2:])
						return
					}
					_, _ = io.WriteString(w, "safe") // Reflection fixture: downstream disconnect is expected.
				})
				resp, err := f.client.Do(f.request("GET", "/reflect", nil))
				if err != nil {
					return
				}
				defer resp.Body.Close()
				data, readErr := io.ReadAll(resp.Body)
				require.NotContains(t, string(data), realKey)
				require.NotContains(t, string(data), tc.value)
				require.True(t, resp.StatusCode >= 400 || readErr != nil, "reflection must reject or abort, not cleanly succeed")
			})
		}
	}
}
func TestIronIdleRevokeAndOutage(t *testing.T) {
	for _, mode := range []string{"revoke", "outage", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			entered, closed := make(chan struct{}), make(chan struct{})
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: safe\n\n")
				w.(http.Flusher).Flush()
				close(entered)
				<-r.Context().Done()
				close(closed) // Cancellation intentionally interrupts the fixture.
			})
			if mode == "expiry" {
				f.expiry = time.Now().Add(600 * time.Millisecond)
			}
			resp, err := f.client.Do(f.request("GET", "/idle", nil))
			require.NoError(t, err)
			defer resp.Body.Close()
			<-entered
			switch mode {
			case "revoke":
				f.revoked.Store(true)
			case "outage":
				f.outage.Store(true)
			}
			select {
			case <-closed:
			case <-time.After(2 * time.Second):
				t.Fatal("idle upstream was not canceled")
			}
			_, err = io.ReadAll(resp.Body)
			require.Error(t, err, "denied streams must not finish cleanly")
			f.assertFinal("canceled", authID)
		})
	}
}
func TestIronAuthorizeOutageBeforeDial(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	f.outage.Store(true)
	resp, err := f.client.Do(f.request("POST", "/never", nil))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 403, resp.StatusCode)
	require.Zero(t, f.hits.Load())
	f.assertFinal("rejected", "")
}

func TestIronFinalOutcomes(t *testing.T) {
	for _, mode := range []string{"success", "postdenied", "reflection", "initial rejection"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if mode == "reflection" {
					w.Header().Set("X-Echo", realKey)
				}
				w.Header().Set("Content-Length", "2")
				_, _ = io.WriteString(w, "ok")
			})
			f.denyResponse.Store(mode == "postdenied")
			req := f.request("POST", "/private-path?private-query="+substitute, strings.NewReader("private-body"))
			if mode == "initial rejection" {
				req.Header.Del("Authorization")
			}
			resp, err := f.client.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			_, err = io.ReadAll(resp.Body)
			require.NoError(t, err)
			outcome, id := "rejected", authID
			if mode == "postdenied" {
				outcome = "canceled"
			}
			if mode == "success" {
				outcome = "forwarded"
				require.Equal(t, 200, resp.StatusCode)
			} else {
				require.Equal(t, 403, resp.StatusCode)
			}
			if mode == "initial rejection" {
				id = ""
				require.Zero(t, f.hits.Load())
			} else {
				require.EqualValues(t, 1, f.hits.Load(), "request authorization allowed upstream forwarding")
			}
			f.assertFinal(outcome, id)
		})
	}
}

func TestFinalizerOnceOnEarlyRejection(t *testing.T) {
	var logs logBuffer
	p := &policy{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	tc := &transform.TransformContext{}
	result, err := p.TransformRequest(context.Background(), tc, httptest.NewRequest("GET", "https://upstream.test/private-path", nil))
	require.NoError(t, err)
	require.Equal(t, transform.ActionReject, result.Action)
	require.NotNil(t, tc.Finalize)
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() { tc.Finalize(&transform.PipelineResult{Action: transform.ActionReject}) })
	}
	wg.Wait()
	require.Equal(t, 1, strings.Count(logs.snapshot(), "\n"))
	require.Contains(t, logs.snapshot(), `"outcome":"rejected"`)
	require.NotContains(t, logs.snapshot(), "private-path")
}

func TestIronFinalBeforePolicy(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	resp, err := f.client.Do(f.request("GET", "/private-path/../private-query", nil))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 400, resp.StatusCode)
	require.Zero(t, f.hits.Load())
	require.Eventually(t, func() bool { return strings.Count(f.logs.snapshot(), "\n") == 1 }, time.Second, time.Millisecond)
	require.Never(t, func() bool { return strings.Count(f.logs.snapshot(), "\n") != 1 }, 100*time.Millisecond, time.Millisecond)
	var event map[string]any
	require.NoError(t, json.Unmarshal([]byte(f.logs.snapshot()), &event))
	require.Equal(t, "rejected", event["outcome"])
	require.Equal(t, "", event["authorizationId"])
	require.Equal(t, "", event["workloadId"])
	require.Len(t, event, 6)
	require.NotContains(t, f.logs.snapshot(), "private-path")
	require.NotContains(t, f.logs.snapshot(), "private-query")
}
func TestIronRevokeBeforeResponseHeaders(t *testing.T) {
	entered, closed := make(chan struct{}), make(chan struct{})
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done(); close(closed) })
	done := make(chan *http.Response, 1)
	go func() {
		resp, err := f.client.Do(f.request("GET", "/delayed", nil))
		if err != nil {
			done <- nil
			return
		}
		done <- resp
	}()
	<-entered
	f.revoked.Store(true)
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("waiting upstream was not canceled")
	}
	resp := <-done
	if resp != nil {
		defer resp.Body.Close()
		require.GreaterOrEqual(t, resp.StatusCode, 400, "policy cancellation is not a successful client disconnect")
	}
}
func TestIronIdentityAndHeaderSlot(t *testing.T) {
	cases := []string{"wrong workload", "forged identity header", "path token", "query token", "body token", "wrong header", "wrong prefix", "duplicate slot", "no client cert"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
			req := f.request("POST", "/resource", nil)
			client := f.client
			switch name {
			case "wrong workload", "forged identity header":
				client = f.httpClient(f.pki.leaf(t, []string{connectorID, "roomote://workload/" + otherWorkload}))
				req.Header.Set("X-Workload-Id", workload)
				req.Header.Set("X-Connector-Identity", connectorID)
			case "path token":
				req = f.request("POST", "/"+substitute, nil)
				req.Header.Del("Authorization")
			case "query token":
				req = f.request("POST", "/?token="+substitute, nil)
				req.Header.Del("Authorization")
			case "body token":
				req = f.request("POST", "/", strings.NewReader(substitute))
				req.Header.Del("Authorization")
			case "wrong header":
				req.Header.Del("Authorization")
				req.Header.Set("X-Custom", substitute)
			case "wrong prefix":
				req.Header.Set("Authorization", "Token "+substitute)
			case "duplicate slot":
				req.Header.Add("Authorization", "Bearer "+substitute)
			case "no client cert":
				client = f.httpClient(tls.Certificate{})
			}
			defer client.CloseIdleConnections()
			resp, err := client.Do(req)
			if err == nil {
				defer resp.Body.Close()
				require.Equal(t, 403, resp.StatusCode)
			}
			require.Zero(t, f.hits.Load())
		})
	}
}
func (f *fixture) connect(target string) (*tls.Conn, *bufio.Reader, int) {
	raw, err := tls.Dial("tcp", f.addr, &tls.Config{RootCAs: f.pki.pool, Certificates: []tls.Certificate{f.connectorCert}, NextProtos: []string{"http/1.1"}})
	require.NoError(f.t, err)
	require.NoError(f.t, raw.SetDeadline(time.Now().Add(3*time.Second)))
	_, err = fmt.Fprintf(raw, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	require.NoError(f.t, err)
	reader := bufio.NewReader(raw)
	resp, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	require.NoError(f.t, err)
	return raw, reader, resp.StatusCode
}
func TestIronCONNECTAdmissionAndAuthority(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	raw, _, status := f.connect(f.target)
	require.Equal(t, 200, status)
	require.NoError(t, raw.Close())
	f.phaseMu.Lock()
	require.Empty(t, f.phases, "CONNECT must not request a substitute")
	f.phaseMu.Unlock()
	for _, name := range []string{"SNI", "Host port", "Host name", "absolute authority"} {
		t.Run(name, func(t *testing.T) {
			raw, _, status := f.connect(f.target)
			require.Equal(t, 200, status)
			defer raw.Close()
			sni := "upstream.test"
			if name == "SNI" {
				sni = "localhost"
			}
			inner := tls.Client(raw, &tls.Config{RootCAs: f.pki.pool, ServerName: sni, NextProtos: []string{"http/1.1"}})
			err := inner.Handshake()
			if name == "SNI" {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			host := f.target
			path := "/"
			if name == "Host port" {
				host = "upstream.test:443"
			}
			if name == "Host name" {
				host = "localhost:443"
			}
			if name == "absolute authority" {
				path = "https://localhost:443/"
			}
			_, err = fmt.Fprintf(inner, "GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n\r\n", path, host, substitute)
			require.NoError(t, err)
			resp, err := http.ReadResponse(bufio.NewReader(inner), &http.Request{Method: "GET"})
			require.NoError(t, err)
			require.GreaterOrEqual(t, resp.StatusCode, 400)
			require.NoError(t, resp.Body.Close())
		})
	}
	require.Zero(t, f.hits.Load())
}
func TestPublicFinalDial(t *testing.T) {
	for _, addr := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "100.100.100.200", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "192.0.2.1", "224.0.0.1"} {
		t.Run(addr, func(t *testing.T) {
			require.False(t, publicIP(netip.MustParseAddr(addr)))
			require.Error(t, publicControl("tcp", net.JoinHostPort(addr, "443"), nil))
		})
	}
	for _, addr := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		require.True(t, publicIP(netip.MustParseAddr(addr)))
		require.NoError(t, publicControl("tcp", net.JoinHostPort(addr, "443"), nil))
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := safeDial(ctx, "tcp", "127.0.0.1:1")
	require.Error(t, err)
	require.Nil(t, conn)
}
func TestStrictSecretClient(t *testing.T) {
	for _, origin := range []string{"http://localhost", "https://user:pass@api.test", "https://api.test/path", "https://api.test?token=key", "https://api.test#fragment"} {
		_, err := newSecretClient(origin, strings.Repeat("g", 32), time.Second)
		require.Error(t, err)
	}
	_, err := newSecretClient("https://api.test", "short", time.Second)
	require.Error(t, err)
	p := newPKI(t)
	cert := p.leaf(t, []string{connectorID, "roomote://workload/" + workload})
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	require.NoError(t, err)
	id, err := identity.FromCertificate(parsed)
	require.NoError(t, err)
	require.Equal(t, workload, id.WorkloadID)
	parsed.URIs = nil
	parsed.Subject.CommonName = connectorID
	_, err = identity.FromCertificate(parsed)
	require.Error(t, err)
}
func TestEchoReaderDoesNotTruncate(t *testing.T) {
	// Byte-for-byte body correctness is exercised via the actual Iron writer too.
	payload := bytes.Repeat([]byte("safe response\n"), 10000)
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = w.Write(payload)
	}) // Fixture disconnects may abort writes.
	resp, err := f.client.Do(f.request("GET", "/large", nil))
	require.NoError(t, err)
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, payload, data)
}
