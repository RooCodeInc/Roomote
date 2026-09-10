import {
  render404Page,
  renderCompletedPage,
  renderResumingPage,
  renderUnavailablePage,
} from '../error-pages';
import { PREVIEW_WIDGET } from '../preview-widget';

describe('preview-proxy branding', () => {
  it('uses the current logo asset in the injected widget', () => {
    expect(PREVIEW_WIDGET).toContain(
      "var roomoteLogoUrl = roomoteAppUrl + '/logos/r.svg';",
    );
  });

  it.each([
    render404Page('0123456789abc'),
    renderUnavailablePage('0123456789abc'),
    renderCompletedPage('0123456789abc'),
    renderResumingPage('0123456789abc', '123'),
  ])('uses the current logo asset in rendered status pages', (page) => {
    expect(page).toContain('/logos/r.svg');
  });

  it('uses the shared left-aligned treatment for resume failures', () => {
    const page = renderResumingPage('0123456789abc', '123');

    expect(page).not.toContain('error-icon');
    expect(page).toContain('<h1 class="title">Resume Failed</h1>');
    expect(page).toContain('<a class="button"');
  });
});
