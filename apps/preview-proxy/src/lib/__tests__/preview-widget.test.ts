import { PREVIEW_WIDGET } from '../preview-widget';

describe('preview widget iframe link interception', () => {
  const interceptSectionStart = PREVIEW_WIDGET.indexOf(
    '// ---- Intercept link clicks to use location.replace() ----',
  );
  const interceptSection = PREVIEW_WIDGET.slice(
    interceptSectionStart,
    interceptSectionStart + 1600,
  );

  it('uses a bubble-phase window click listener for fallback navigation', () => {
    expect(interceptSection).toContain("window.addEventListener('click'");
    expect(interceptSection).toContain('}, false);');
    expect(interceptSection).not.toContain(
      "document.addEventListener('click', function(e)",
    );
  });

  it('skips fallback navigation when app code already handled the click', () => {
    expect(interceptSection).toContain('if (e.defaultPrevented) return;');
    expect(interceptSection).toContain('location.replace(el.href);');
  });
});
