import { render404Page } from '../error-pages';
import { PREVIEW_WIDGET } from '../preview-widget';

describe('preview-proxy branding', () => {
  it('uses the current logo asset in the injected widget', () => {
    expect(PREVIEW_WIDGET).toContain(
      "var roomoteLogoUrl = openRoomoteAppUrl + '/logos/r.svg';",
    );
  });

  it('uses the current logo asset in rendered error pages', () => {
    const page = render404Page('0123456789abc');

    expect(page).toContain('/logos/r.svg');
  });
});
