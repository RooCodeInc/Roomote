// Exact, fail-on-drift hooks against iron.lock. No vendored replacement proxy.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
function patch(file, replacements) {
  const path = join(root, file);
  let text = readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (text.split(before).length !== 2) throw new Error(`Iron hook drift: ${file}: ${before.slice(0, 90)}`);
    text = text.replace(before, after);
  }
  writeFileSync(path, text);
}
patch('cmd/iron-proxy/main.go', [['func main() {', 'func ironMain() {']]);
patch('internal/transform/transform.go', [
  ['type TransformContext struct {', `type TransformContext struct {
  // Optional exchange hooks; installed by a policy that owns response release.
  Finalize func(*PipelineResult)
  BeforeWrite func() error
  WriteContext context.Context`],
  ['type TunnelInfo struct {', `type TunnelInfo struct {
  // Verified outer connector certificate; never taken from inner TLS or headers.
  ClientCert *x509.Certificate`],
  ['type PipelineResult struct {', 'type PipelineResult struct {\n PolicyManaged bool'],
]);
patch('internal/proxy/proxy.go', [
  ['"crypto/tls"', '"crypto/tls"\n "crypto/x509"'],
  ['type Proxy struct {', 'type Proxy struct {\n connectorTLS *tls.Config\n exchangeRejected func()'],
  ['type Options struct {', `type Options struct {
  ConnectorTLS *tls.Config
  ExchangeRejected func()
  UpstreamRootCAs *x509.CertPool
  UpstreamDialContext func(context.Context, string, string) (net.Conn, error)`],
  ['ready:                opts.Ready,', 'ready:                opts.Ready,\n connectorTLS: opts.ConnectorTLS,\n exchangeRejected: opts.ExchangeRejected,'],
  ['p.httpServer = &http.Server{', `if opts.UpstreamDialContext != nil { p.transport.DialContext = opts.UpstreamDialContext }
  if opts.UpstreamRootCAs != nil { p.transport.TLSClientConfig.RootCAs = opts.UpstreamRootCAs }
  p.httpServer = &http.Server{`],
  ['func (p *Proxy) ListenAndServe() error {', `func (p *Proxy) ListenAndServe() error {
  if p.connectorTLS != nil {
    ln, err := net.Listen("tcp", p.httpServer.Addr)
    if err != nil { return err }
    return p.ServeConnector(ln)
  }`],
  ['func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request, tunnelInfo *transform.TunnelInfo) {', `func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request, tunnelInfo *transform.TunnelInfo) {
  finalized := false
  defer func() { if !finalized && p.exchangeRejected != nil { p.exchangeRejected() } }()`],
  ['pl, finish := p.beginPipelineRun(result)\n\tdefer finish()\n\n\tif !p.isReady()', `pl, finish := p.beginPipelineRun(result)
  defer finish()
  defer func() { if tctx.Finalize != nil { finalized = true; tctx.Finalize(result) } }()
  if tunnelInfo != nil { tctx.ClientCert = tunnelInfo.ClientCert }

  if !p.isReady()`],
  ['r.Body = transform.NewBufferedBody(r.Body, bodyLimits.MaxRequestBodyBytes)', 'requestHasNoBody := r.Body == nil || r.Body == http.NoBody\n r.Body = transform.NewBufferedBody(r.Body, bodyLimits.MaxRequestBodyBytes)'],
  ['copyHeaders(upstreamReq.Header, r.Header)', 'if requestHasNoBody { upstreamReq.Body = http.NoBody }\n copyHeaders(upstreamReq.Header, r.Header)'],
  ['result.BodyCapture = tctx.BodyCapture', 'result.PolicyManaged = tctx.Finalize != nil\n result.BodyCapture = tctx.BodyCapture'],
  ['func markIfClientCancel(r *http.Request, err error, result *transform.PipelineResult) bool {', 'func markIfClientCancel(r *http.Request, err error, result *transform.PipelineResult) bool {\n if result.PolicyManaged { return false }'],
  ['// SSE: stream with flushing', `if tctx.BeforeWrite != nil {
    guarded := &boundaryWriter{ResponseWriter: w, check: tctx.BeforeWrite, result: result}
    w = guarded
    if tctx.WriteContext != nil {
      stop := context.AfterFunc(tctx.WriteContext, func() {
        _ = http.NewResponseController(guarded.ResponseWriter).SetWriteDeadline(time.Now())
      })
      defer stop()
    }
  }
  // SSE: stream with flushing`],
  ['defer writeTrailers(w, resp)', 'if _, protected := w.(*boundaryWriter); !protected { defer writeTrailers(w, resp) }'],
  ['p.logger.Warn("SSE copy error", slog.String("error", err.Error()))', 'abortProtected(w)\n p.logger.Warn("SSE copy error", slog.String("error", err.Error()))'],
  ['p.logger.Warn("SSE write error", slog.String("error", writeErr.Error()))', 'abortProtected(w)\n p.logger.Warn("SSE write error", slog.String("error", writeErr.Error()))'],
  ['p.logger.Warn("SSE read error", slog.String("error", readErr.Error()))', 'abortProtected(w)\n p.logger.Warn("SSE read error", slog.String("error", readErr.Error()))'],
  ['p.logger.Warn("response body copy error", slog.String("error", err.Error()))\n\t\t}', 'abortProtected(w)\n p.logger.Warn("response body copy error", slog.String("error", err.Error()))\n\t\t}'],
]);
patch('internal/proxy/tunnel.go', [
  ['"context"', '"context"\n "crypto/x509"'],
  ['p.tunnelTransformCheck(req.RemoteAddr, host, req.Header)', 'p.tunnelTransformCheck(req.RemoteAddr, host, req.Header, verifiedConnectorCert(req))'],
  ['defer conn.Close()\n\n\t// Send 200', 'defer conn.Close()\n stopShutdown := context.AfterFunc(p.shutdownCtx, func(){ _ = conn.Close() })\n defer stopShutdown()\n\n\t// Send 200'],
  ['if err := tlsConn.HandshakeContext(context.Background()); err != nil {', 'handshakeCtx, cancel := context.WithTimeout(p.shutdownCtx, 10*time.Second)\n defer cancel()\n if err := tlsConn.HandshakeContext(handshakeCtx); err != nil {'],
  ['connectHeaders http.Header) (bool, *http.Response, *transform.TunnelInfo)', 'connectHeaders http.Header, certificates ...*x509.Certificate) (bool, *http.Response, *transform.TunnelInfo)'],
  ['result := &transform.PipelineResult{\n\t\tHost:       target,', `if len(certificates) == 1 { tctx.ClientCert = certificates[0] }
  result := &transform.PipelineResult{
    Host:       target,`],
  ['Target:            target,\n\t\tRequestTransforms:', 'Target:            target,\n ClientCert: tctx.ClientCert,\n\t\tRequestTransforms:'],
  ['Target:            info.Target,', 'Target:            info.Target,\n ClientCert: info.ClientCert,'],
  ['GetCertificate: p.getCertificate,\n\t\tNextProtos:     []string{"h2", "http/1.1"}, // offer HTTP/2 to tunnelled clients', `GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
      if tunnelInfo != nil && tunnelInfo.ClientCert != nil {
        host, _, err := net.SplitHostPort(target)
        if err != nil || hello.ServerName != host { return nil, fmt.Errorf("tunnel authority mismatch") }
      }
      return p.getCertificate(hello)
    },
    NextProtos: func() []string {
      if tunnelInfo != nil && tunnelInfo.ClientCert != nil { return []string{"http/1.1"} }
      return []string{"h2", "http/1.1"}
    }(),`],
]);
