// The preview widget script that gets injected into sandbox HTML pages.
// Runs in the browser - must be self-contained with no imports.
export const PREVIEW_WIDGET = `
(function() {
  if (document.documentElement.hasAttribute('data-roomote-injected')) return;
  document.documentElement.setAttribute('data-roomote-injected', '1');

  var taskUrl = null;
  var isInIframe = false;
  try { isInIframe = window.self !== window.top; } catch (e) { isInIframe = true; }

  // Extract taskId from hostname ({taskId}-{portName}.{domain}) and build task URL
  var roomoteAppUrl = '__R_APP_URL__';
  var roomoteLogoUrl = roomoteAppUrl + '/logos/r.svg';
  var hostParts = location.hostname.split('.');
  if (hostParts.length > 1) {
    var subdomain = hostParts[0];
    var hyphenIdx = subdomain.indexOf('-');
    if (hyphenIdx >= 0) {
      var potentialTaskId = subdomain.substring(0, hyphenIdx);
      if (/^[0-9a-z]{13}$/.test(potentialTaskId)) {
        taskUrl = roomoteAppUrl + '/task/' + potentialTaskId;
      }
    }
  }

  var container = document.createElement('div');
  container.id = 'roomote-overlay';

  var shadow = container.attachShadow({ mode: 'closed' });
  shadow.innerHTML = \`
    <style>
      @keyframes roomote-drag {
        0%, 100% { transform: rotate(-2deg); }
        50% { transform: rotate(2deg); }
      }
      :host {
        position: fixed;
        bottom: 0;
        left: 0;
        z-index: 2147483647;
        pointer-events: auto;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      .roomote-pill {
        display: flex;
        align-items: center;
        height: 30px;
        border-radius: 0;
        background: #1a1a2e;
        border: 1px solid rgba(255,255,255,0.25);
        cursor: grab;
        opacity: 0.7;
        transition: opacity 0.2s, transform 0.15s ease;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        overflow: hidden;
      }
      .roomote-pill.dragging {
        cursor: grabbing;
        opacity: 1;
        animation: roomote-drag 0.4s ease-in-out infinite;
      }
      .roomote-pill:hover {
        opacity: 1;
      }
      .roomote-pill.hidden {
        display: none;
      }
      .roomote-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        cursor: pointer;
        border: none;
        background: transparent;
        padding: 0;
        color: rgba(255,255,255,0.7);
        transition: color 0.15s;
      }
      .roomote-action:hover {
        color: #fff;
      }
      .roomote-action svg {
        width: 18px;
        height: 18px;
      }
      .roomote-logo-mark {
        width: 18px;
        height: 18px;
        display: block;
        filter: invert(1);
      }
      .roomote-divider {
        width: 1px;
        height: 18px;
        background: rgba(255,255,255,0.2);
        flex-shrink: 0;
      }
      .roomote-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 30px;
        flex-shrink: 0;
        cursor: pointer;
        border: none;
        background: transparent;
        padding: 0;
        color: rgba(255,255,255,0.5);
        transition: color 0.15s;
      }
      .roomote-close:hover {
        color: #fff;
      }
      .roomote-close svg {
        width: 16px;
        height: 16px;
      }

      /* Element picker overlay */
      .roomote-picker-overlay {
        display: none;
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 2147483646;
        cursor: crosshair;
      }
      .roomote-picker-overlay.active {
        display: block;
      }
      .roomote-picker-highlight {
        position: fixed;
        pointer-events: none;
        border: 2px solid #6366f1;
        background: rgba(99,102,241,0.1);
        border-radius: 2px;
        z-index: 2147483646;
        transition: all 0.1s ease;
      }
      .roomote-picker-tooltip {
        position: fixed;
        pointer-events: none;
        background: #1a1a2e;
        color: #fff;
        font-size: 11px;
        font-family: monospace;
        padding: 4px 8px;
        border-radius: 4px;
        z-index: 2147483647;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
    </style>
    <div class="roomote-pill">
      <button class="roomote-action" data-action="open-task" title="Open task">
        <img src="\${roomoteLogoUrl}" alt="" aria-hidden="true" class="roomote-logo-mark">
      </button>
      <button class="roomote-action" data-action="pick-element" title="Reference an element">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/></svg>
      </button>
      <div class="roomote-divider"></div>
      <button class="roomote-close" title="Hide Roomote widget">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- Picker highlight/tooltip (outside shadow for measuring) -->
    <div class="roomote-picker-highlight" style="display:none;"></div>
    <div class="roomote-picker-tooltip" style="display:none;"></div>
  \`;

  var pill = shadow.querySelector('.roomote-pill');
  var closeBtn = shadow.querySelector('.roomote-close');
  var openTaskBtn = shadow.querySelector('[data-action="open-task"]');
  var pickElementBtn = shadow.querySelector('[data-action="pick-element"]');
  var highlight = shadow.querySelector('.roomote-picker-highlight');
  var tooltip = shadow.querySelector('.roomote-picker-tooltip');

  // ---- Conditionally show/hide action buttons based on iframe context ----
  // "Reference an element" only works inside an iframe (communicates with parent)
  // "Open task" only works when taskUrl is set (received via roomote-init from parent)
  // Show the appropriate action button based on context
  if (isInIframe) {
    openTaskBtn.style.display = 'none';
  } else {
    pickElementBtn.style.display = 'none';
    // Hide open-task if we couldn't resolve a task URL from the hostname
    if (!taskUrl) openTaskBtn.style.display = 'none';
  }

  // ---- Open task ----
  openTaskBtn.addEventListener('click', function() {
    if (taskUrl) {
      // Append the current preview path so the recipient sees the same page
      var previewPath = location.pathname + location.search + location.hash;
      var separator = taskUrl.indexOf('?') >= 0 ? '&' : '?';
      var fullUrl = taskUrl + separator + 'preview=' + encodeURIComponent(previewPath);
      window.open(fullUrl, '_blank', 'noopener,noreferrer');
    }
  });

  // ---- Close widget ----
  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    pill.classList.add('hidden');
    window.parent.postMessage({ type: 'roomote-widget-hidden' }, '*');
  });

  // ---- Drag to reposition ----
  var DRAG_THRESHOLD = 4; // px before a mousedown becomes a drag
  var STORAGE_KEY = 'roomote-widget-pos';
  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragStartLeft = 0;
  var dragStartTop = 0;
  var didDrag = false;

  // Restore saved position from localStorage
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      var pos = JSON.parse(saved);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        // Switch from bottom/left to top/left positioning
        container.style.bottom = 'auto';
        container.style.left = pos.left + 'px';
        container.style.top = pos.top + 'px';
      }
    }
  } catch(e) {}

  function clampToViewport() {
    var rect = container.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = rect.left;
    var top = rect.top;
    var changed = false;
    if (left < 0) { left = 0; changed = true; }
    if (top < 0) { top = 0; changed = true; }
    if (left + rect.width > vw) { left = vw - rect.width; changed = true; }
    if (top + rect.height > vh) { top = vh - rect.height; changed = true; }
    if (changed) {
      container.style.left = left + 'px';
      container.style.top = top + 'px';
      container.style.bottom = 'auto';
    }
  }

  function savePosition() {
    try {
      var rect = container.getBoundingClientRect();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch(e) {}
  }

  function getPointerPos(e) {
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function onDragStart(e) {
    if (pickerActive) return;

    var p = getPointerPos(e);
    dragStartX = p.x;
    dragStartY = p.y;
    var rect = container.getBoundingClientRect();
    dragStartLeft = rect.left;
    dragStartTop = rect.top;
    isDragging = true;
    didDrag = false;

    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDragEnd, true);
    document.addEventListener('touchmove', onDragMove, { passive: false, capture: true });
    document.addEventListener('touchend', onDragEnd, true);
    document.addEventListener('touchcancel', onDragEnd, true);
  }

  // Suppress button clicks when a drag just finished
  pill.addEventListener('click', function(e) {
    if (didDrag) {
      e.stopPropagation();
      e.preventDefault();
      didDrag = false;
    }
  }, true);

  function onDragMove(e) {
    if (!isDragging) return;
    var p = getPointerPos(e);
    var dx = p.x - dragStartX;
    var dy = p.y - dragStartY;

    if (!didDrag && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
      return; // Below threshold, not a drag yet
    }

    if (!didDrag) {
      didDrag = true;
      pill.classList.add('dragging');
    }

    e.preventDefault();

    var newLeft = dragStartLeft + dx;
    var newTop = dragStartTop + dy;

    // Clamp to viewport
    var pillRect = pill.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    if (newLeft < 0) newLeft = 0;
    if (newTop < 0) newTop = 0;
    if (newLeft + pillRect.width > vw) newLeft = vw - pillRect.width;
    if (newTop + pillRect.height > vh) newTop = vh - pillRect.height;

    container.style.left = newLeft + 'px';
    container.style.top = newTop + 'px';
    container.style.bottom = 'auto';
  }

  function onDragEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    pill.classList.remove('dragging');

    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDragEnd, true);
    document.removeEventListener('touchmove', onDragMove, true);
    document.removeEventListener('touchend', onDragEnd, true);
    document.removeEventListener('touchcancel', onDragEnd, true);

    if (didDrag) {
      savePosition();
      // Prevent the mouseup from triggering a click on buttons
      e.stopPropagation();
    }
  }

  pill.addEventListener('mousedown', onDragStart);
  pill.addEventListener('touchstart', onDragStart, { passive: true });

  // Re-clamp when the window resizes
  window.addEventListener('resize', clampToViewport);

  // ---- Element Picker ----
  var pickerActive = false;
  var hoveredEl = null;

  function getElementPath(el, maxDepth) {
    maxDepth = maxDepth || 4;
    var parts = [];
    var current = el;
    var depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < maxDepth) {
      var tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(tag + '#' + current.id);
        break;
      }
      var cls = Array.from(current.classList || [])
        .filter(function(c) { return !/^[a-z0-9]{5,8}$/.test(c); }) // filter hash classes
        .slice(0, 2)
        .join('.');
      parts.unshift(cls ? tag + '.' + cls : tag);
      current = current.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function getElementName(el) {
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || '').trim().substring(0, 40);
    if (el.getAttribute('aria-label')) return tag + ' "' + el.getAttribute('aria-label') + '"';
    if (tag === 'img') return 'image' + (el.alt ? ' "' + el.alt + '"' : '');
    if (tag === 'a') return 'link' + (text ? ' "' + text + '"' : '');
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button' + (text ? ' "' + text + '"' : '');
    if (tag === 'input') return 'input[' + (el.type || 'text') + ']' + (el.placeholder ? ' "' + el.placeholder + '"' : '');
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea' + (el.placeholder ? ' "' + el.placeholder + '"' : '');
    if (text) return tag + ' "' + text + '"';
    return tag;
  }

  function getNearbyText(el) {
    var prev = el.previousElementSibling;
    var next = el.nextElementSibling;
    var parts = [];
    if (prev) {
      var t = (prev.textContent || '').trim().substring(0, 30);
      if (t) parts.push('[before: "' + t + '"]');
    }
    var own = (el.textContent || '').trim().substring(0, 50);
    if (own) parts.push(own);
    if (next) {
      var t2 = (next.textContent || '').trim().substring(0, 30);
      if (t2) parts.push('[after: "' + t2 + '"]');
    }
    return parts.join(' ');
  }

  function getCleanClasses(el) {
    return Array.from(el.classList || [])
      .filter(function(c) { return !/^[a-z0-9]{5,8}$/.test(c); })
      .join(', ');
  }

  function updateHighlight(el) {
    if (!el) {
      highlight.style.display = 'none';
      tooltip.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.top = rect.top + 'px';
    highlight.style.left = rect.left + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    var name = getElementName(el);
    tooltip.textContent = name;
    tooltip.style.display = 'block';
    var tooltipTop = rect.top - 28;
    if (tooltipTop < 4) tooltipTop = rect.bottom + 4;
    tooltip.style.top = tooltipTop + 'px';
    tooltip.style.left = rect.left + 'px';
  }

  function onPickerMouseMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    // Ignore our own overlay elements
    if (!el || el === container || container.contains(el)) {
      updateHighlight(null);
      hoveredEl = null;
      return;
    }
    hoveredEl = el;
    updateHighlight(el);
  }

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!hoveredEl) return;

    var el = hoveredEl;
    var context = {
      element: getElementName(el),
      url: location.href,
      path: getElementPath(el),
      nearbyText: getNearbyText(el),
      cssClasses: getCleanClasses(el),
      boundingBox: {
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };

    stopPicker();
    window.parent.postMessage({ type: 'roomote-element-picked', context: context }, '*');
  }

  function onPickerKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopPicker();
    }
  }

  function startPicker() {
    pickerActive = true;
    document.addEventListener('mousemove', onPickerMouseMove, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKeydown, true);
    document.body.style.cursor = 'crosshair';
  }

  function stopPicker() {
    pickerActive = false;
    hoveredEl = null;
    document.removeEventListener('mousemove', onPickerMouseMove, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKeydown, true);
    document.body.style.cursor = '';
    updateHighlight(null);
  }

  pickElementBtn.addEventListener('click', function() {
    startPicker();
  });

  // ---- Intercept link clicks to use location.replace() ----
  // Prevents iframe navigations from adding entries to the parent window's
  // joint session history. The parent UI has its own back/forward buttons.
  if (isInIframe) {
    window.addEventListener('click', function(e) {
      var el = e.target;
      while (el && el.tagName !== 'A') el = el.parentElement;
      if (!el || !el.href) return;
      var target = el.getAttribute('target');
      if (target && target !== '_self') return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (el.hasAttribute('download')) return;
      if (/^(javascript|mailto|tel):/.test(el.href)) return;
      // Let client-side routers (e.g. Next.js Link) handle in-app navigation first.
      if (e.defaultPrevented) return;
      e.preventDefault();
      location.replace(el.href);
    }, false);
  }

  // ---- Navigation bridge ----
  var lastReportedUrl = '';
  var previewNavigationStorageKey = '__roomote_preview_navigation__';

  function loadPreviewNavigationState() {
    if (!isInIframe) {
      return { entries: [], index: -1 };
    }

    try {
      var raw = window.sessionStorage.getItem(previewNavigationStorageKey);
      if (!raw) {
        return { entries: [], index: -1 };
      }

      var parsed = JSON.parse(raw);
      var entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(function(entry) {
            return typeof entry === 'string' && entry.length > 0;
          })
        : [];

      if (!entries.length) {
        return { entries: [], index: -1 };
      }

      var index = typeof parsed.index === 'number'
        ? parsed.index
        : entries.length - 1;

      if (index < 0) index = 0;
      if (index >= entries.length) index = entries.length - 1;

      return { entries: entries, index: index };
    } catch (e) {
      return { entries: [], index: -1 };
    }
  }

  var previewNavigationState = loadPreviewNavigationState();

  function savePreviewNavigationState() {
    if (!isInIframe) return;

    try {
      window.sessionStorage.setItem(
        previewNavigationStorageKey,
        JSON.stringify(previewNavigationState)
      );
    } catch (e) {}
  }

  function syncPreviewNavigationState(url, mode) {
    if (!isInIframe) return;

    if (previewNavigationState.index === -1 || !previewNavigationState.entries.length) {
      previewNavigationState = {
        entries: [url],
        index: 0,
      };
      savePreviewNavigationState();
      return;
    }

    if (mode === 'replace') {
      previewNavigationState.entries[previewNavigationState.index] = url;
      savePreviewNavigationState();
      return;
    }

    if (previewNavigationState.entries[previewNavigationState.index] === url) {
      return;
    }

    previewNavigationState.entries = previewNavigationState.entries.slice(
      0,
      previewNavigationState.index + 1,
    );
    previewNavigationState.entries.push(url);
    previewNavigationState.index = previewNavigationState.entries.length - 1;
    savePreviewNavigationState();
  }

  function canGoPreviewBack() {
    return isInIframe ? previewNavigationState.index > 0 : history.length > 1;
  }

  function navigatePreviewHistory(delta) {
    if (!isInIframe) {
      if (delta < 0) history.back();
      if (delta > 0) history.forward();
      return;
    }

    var nextIndex = previewNavigationState.index + delta;
    if (nextIndex < 0 || nextIndex >= previewNavigationState.entries.length) {
      return;
    }

    previewNavigationState.index = nextIndex;
    savePreviewNavigationState();
    location.replace(previewNavigationState.entries[nextIndex]);
  }

  function reportNavigation(mode) {
    var url = location.href;
    // Strip transient auth-flow params so they never appear in the
    // URL display, navigation history, or ?preview search param.
    if (url.indexOf('__preview_token') !== -1) {
      try {
        var u = new URL(url);
        u.searchParams.delete('__preview_token');
        u.searchParams.delete('__preview_token_redirect');
        url = u.toString();
      } catch(e) {}
    }
    if (url === lastReportedUrl) return;
    syncPreviewNavigationState(url, mode);
    lastReportedUrl = url;
    window.parent.postMessage({
      type: 'roomote-navigation',
      url: url,
      canGoBack: canGoPreviewBack(),
    }, '*');
  }

  // Monkey-patch pushState/replaceState to detect SPA navigations.
  // In iframe context, pushState is redirected to replaceState to avoid
  // adding entries to the parent window's joint session history. The widget
  // keeps its own navigation stack so task-side back/forward still works.
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;
  history.pushState = function() {
    var fn = isInIframe ? origReplaceState : origPushState;
    var result = fn.apply(this, arguments);
    reportNavigation('push');
    return result;
  };
  history.replaceState = function() {
    var result = origReplaceState.apply(this, arguments);
    reportNavigation('replace');
    return result;
  };

  window.addEventListener('popstate', reportNavigation);
  window.addEventListener('hashchange', reportNavigation);

  // Report initial URL once DOM is ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    reportNavigation();
  } else {
    window.addEventListener('DOMContentLoaded', reportNavigation);
  }

  // ---- Messages from parent ----
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'roomote-widget-show') {
      pill.classList.remove('hidden');
    }
    if (e.data.type === 'roomote-init') {
      taskUrl = e.data.taskUrl || taskUrl;
      // Report current URL on init so parent has it immediately
      reportNavigation();
    }
    if (e.data.type === 'roomote-nav-back') {
      navigatePreviewHistory(-1);
    }
    if (e.data.type === 'roomote-nav-forward') {
      navigatePreviewHistory(1);
    }
    if (e.data.type === 'roomote-nav-reload') {
      location.reload();
    }
    if (e.data.type === 'roomote-nav-home' && e.data.url) {
      location.href = e.data.url;
    }
  });

  // Signal load-complete so the parent can stop the loading spinner
  function reportLoadComplete() {
    window.parent.postMessage({ type: 'roomote-load-complete' }, '*');
  }
  if (document.readyState === 'complete') {
    reportLoadComplete();
  } else {
    window.addEventListener('load', reportLoadComplete);
  }

  function mount() {
    if (document.body) {
      document.body.appendChild(container);
      clampToViewport();
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        document.body.appendChild(container);
        clampToViewport();
      });
    }
  }
  mount();
})();
`;
