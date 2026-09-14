package roomote

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestAuthenticatedProxyPOSTStripsInternalHeaders(t *testing.T) {
	f := newFixtureMode(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer "+realKey, r.Header.Get("Authorization"))
		for name, values := range r.Header {
			lower := strings.ToLower(name)
			require.False(t, strings.HasPrefix(lower, "proxy-") || strings.HasPrefix(lower, "x-roomote-") || strings.HasPrefix(lower, "x-session-egress-") || strings.HasPrefix(lower, "x-forwarded-"))
			require.NotContains(t, strings.Join(values, " "), capability)
		}
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.Equal(t, "fixture-body", string(body))
		io.WriteString(w, "ok")
	}, true)
	req := f.request("POST", "/records", strings.NewReader("fixture-body"))
	req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("workload:"+capability)))
	req.Header.Set("X-Roomote-Proxy-Capability", capability)
	req.Header.Set("X-Session-Egress-Identity", "forged")
	req.Header.Set("X-Forwarded-For", "forged")
	resp, err := f.client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, "ok", string(body))
	require.EqualValues(t, 1, f.hits.Load())
	f.assertFinal("forwarded", authID)
	require.NotContains(t, f.logs.snapshot(), capability)
}

func TestAuthenticatedProxyRejectsMissingOrWrongCapability(t *testing.T) {
	for _, password := range []string{"", "rproxy_" + strings.Repeat("z", 43)} {
		t.Run(password[:min(8, len(password))], func(t *testing.T) {
			f := newFixtureMode(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("unauthenticated upstream access") }, true)
			proxyURL, err := url.Parse("https://" + f.addr)
			require.NoError(t, err)
			if password != "" {
				proxyURL.User = url.UserPassword("workload", password)
			}
			f.client.Transport.(*http.Transport).Proxy = http.ProxyURL(proxyURL)
			// A real external connector certificate does not replace proxy auth.
			f.client.Transport.(*http.Transport).TLSClientConfig.Certificates = []tls.Certificate{f.connectorCert}
			resp, err := f.client.Do(f.request("GET", "/records", nil))
			if resp != nil {
				resp.Body.Close()
			}
			require.Error(t, err)
			require.EqualValues(t, 0, f.hits.Load())
		})
	}
}

func TestProxyCapabilityCannotReplaceExternalConnectorCertificate(t *testing.T) {
	f := newFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("proxy capability entered mTLS mode") })
	proxyURL, err := url.Parse("https://" + f.addr)
	require.NoError(t, err)
	proxyURL.User = url.UserPassword("workload", capability)
	f.client.Transport.(*http.Transport).Proxy = http.ProxyURL(proxyURL)
	f.client.Transport.(*http.Transport).TLSClientConfig.Certificates = nil
	resp, err := f.client.Do(f.request("GET", "/records", nil))
	if resp != nil {
		resp.Body.Close()
	}
	require.Error(t, err)
	require.EqualValues(t, 0, f.hits.Load())
}

func TestAuthenticatedProxyRequiresServiceSubstituteAndSuppressesEcho(t *testing.T) {
	for _, mode := range []string{"wrong substitute", "echo"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixtureMode(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, realKey) }, true)
			req := f.request("GET", "/records", nil)
			if mode == "wrong substitute" {
				req.Header.Set("Authorization", "Bearer rses_"+strings.Repeat("z", 40))
			}
			resp, err := f.client.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			require.NotEqual(t, 200, resp.StatusCode)
			require.NotContains(t, string(body), realKey)
			if mode == "wrong substitute" {
				require.EqualValues(t, 0, f.hits.Load())
			}
		})
	}
}

func TestAuthenticatedProxyClosesIdleStreamsAndBareTunnels(t *testing.T) {
	for _, mode := range []string{"revoke", "expiry", "outage"} {
		for _, bare := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/bare=%t", mode, bare), func(t *testing.T) {
				closed := make(chan struct{})
				f := newFixtureMode(t, func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "data: safe\n\n")
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					close(closed)
				}, true)
				if mode == "expiry" {
					f.expiry.Store(time.Now().Add(600 * time.Millisecond).UnixNano())
				}
				var body io.ReadCloser
				if bare {
					conn, err := tls.Dial("tcp", f.addr, &tls.Config{RootCAs: f.pki.pool})
					require.NoError(t, err)
					defer conn.Close()
					conn.SetDeadline(time.Now().Add(2 * time.Second))
					fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: Basic %s\r\n\r\n", f.target, f.target, base64.StdEncoding.EncodeToString([]byte("workload:"+capability)))
					reader := bufio.NewReader(conn)
					resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
					require.NoError(t, err)
					require.Equal(t, 200, resp.StatusCode)
					body = conn
				} else {
					resp, err := f.client.Do(f.request("GET", "/idle", nil))
					require.NoError(t, err)
					body = resp.Body
				}
				defer body.Close()
				if mode == "revoke" {
					f.revoked.Store(true)
				}
				if mode == "outage" {
					f.outage.Store(true)
				}
				_, err := io.ReadAll(body)
				if bare {
					if e, ok := err.(net.Error); ok {
						require.False(t, e.Timeout(), "tunnel survived until test timeout")
					}
				} else {
					require.Error(t, err)
					select {
					case <-closed:
					case <-time.After(time.Second):
						t.Fatal("upstream stream remained open")
					}
				}
			})
		}
	}
}
