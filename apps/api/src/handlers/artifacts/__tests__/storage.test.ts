import { resolveArtifactPresignEndpointForRequest } from '../storage';

describe('resolveArtifactPresignEndpointForRequest', () => {
  it('signs host-local MinIO URLs for local Docker workers', () => {
    expect(
      resolveArtifactPresignEndpointForRequest(
        'host.docker.internal:13001',
        'http://localhost:19000',
      ),
    ).toBe('http://host.docker.internal:19000');

    expect(
      resolveArtifactPresignEndpointForRequest(
        'http://host.docker.internal:13001',
        'http://127.0.0.1:19000',
      ),
    ).toBe('http://host.docker.internal:19000');
  });

  it('keeps host-local MinIO URLs unchanged for browser or host API requests', () => {
    expect(
      resolveArtifactPresignEndpointForRequest(
        'localhost:13001',
        'http://localhost:19000',
      ),
    ).toBe('http://localhost:19000');
  });

  it('keeps compose and hosted S3 endpoints unchanged', () => {
    expect(
      resolveArtifactPresignEndpointForRequest(
        'host.docker.internal:13001',
        'http://minio:9000',
      ),
    ).toBe('http://minio:9000');

    expect(
      resolveArtifactPresignEndpointForRequest(
        'host.docker.internal:13001',
        'https://s3.example.com',
      ),
    ).toBe('https://s3.example.com');
  });
});
