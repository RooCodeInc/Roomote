import { config } from '../config';

const FONT_STACK = `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;

const GOOGLE_FONTS_LINKS = `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const ROOMOTE_LOGO_MARKUP = `<img src="${config.R_APP_URL}/logos/r.svg" width="50" height="50" alt="Roomote" class="roomote-logo">`;

const SHARED_STYLE = `
          :root {
            --background: 0 0% 100%;
            --foreground: 240 10% 3.9%;
            --muted-foreground: 240 3.8% 46.1%;
            --border: 240 5.9% 90%;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --background: 240 10% 3.9%;
              --foreground: 0 0% 98%;
              --muted-foreground: 240 5% 64.9%;
              --border: 240 3.7% 15.9%;
            }
            .roomote-logo {
              filter: invert(1);
            }
          }
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: ${FONT_STACK};
            font-size: 0.875rem;
            line-height: 1.5;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background-color: hsl(var(--background));
            color: hsl(var(--foreground));
          }
          .page-container {
            width: 100%;
            max-width: 560px;
            padding: 1.5rem;
          }
          .roomote-logo {
            display: block;
            margin-bottom: 1rem;
            width: 50px;
            height: 50px;
          }
          h1 {
            font-size: 1.5rem;
            font-weight: 600;
            letter-spacing: -0.025em;
          }
          p {
            margin: 0.75em 0;
          }
          code {
            background: hsl(var(--muted-foreground) / 0.1);
            padding: 0.125rem 0.375rem;
            border-radius: 0.25rem;
            font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
            font-size: 0.8125rem;
          }
          a {
            color: hsl(var(--foreground));
            text-decoration: underline;
            text-underline-offset: 2px;
          }
          a:hover {
            text-decoration-color: hsl(var(--muted-foreground));
          }
          a.button {
            background: hsl(var(--foreground));
            border-radius: 2rem;
            color: hsl(var(--background));
            display: inline-block;
            margin: 1rem 0 0;
            padding: 0.5rem 1rem;
            text-decoration: none;
          }
          a.button:hover {
            opacity: 0.7;
          }
          ul {
            line-height: 1.8;
            padding-left: 1.25rem;
            margin-left: 0rem;
          }
          .spinner {
            border: 3px solid hsl(var(--border));
            border-top: 3px solid hsl(var(--foreground));
            border-radius: 50%;
            width: 2rem;
            height: 2rem;
            animation: spin 1s linear infinite;
            margin-top: 1.5rem;
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .header {
            margin-bottom: 2rem;
          }
          .title {
            font-size: 1.25rem;
            font-weight: 600;
            letter-spacing: -0.025em;
            margin-bottom: 0.5rem;
          }
          .subtitle {
            font-size: 0.875rem;
            color: hsl(var(--muted-foreground));
          }
          .progress-steps {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
          }
          .step {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.875rem;
            animation: fadeSlideIn 0.5s ease-out both;
          }
          .step:nth-child(1) { animation-delay: 0ms; }
          .step:nth-child(2) { animation-delay: 100ms; }
          .step:nth-child(3) { animation-delay: 200ms; }
          .step:nth-child(4) { animation-delay: 300ms; }
          @keyframes fadeSlideIn {
            from { opacity: 0; transform: translateY(-0.5rem); }
            to { opacity: 1; transform: translateY(0); }
          }
          .step-icon {
            width: 1rem;
            height: 1rem;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .step-icon svg {
            width: 1rem;
            height: 1rem;
          }
          .step-icon .spinner {
            width: 1rem;
            height: 1rem;
            border-width: 2px;
            margin: 0;
          }
          .step.pending .step-icon { color: hsl(var(--muted-foreground) / 0.3); }
          .step.active .step-icon { color: hsl(var(--muted-foreground) / 0.5); }
          .step.completed .step-icon { color: hsl(var(--muted-foreground)); }
          .step.pending .step-text { color: hsl(var(--muted-foreground) / 0.5); }
          .step.active .step-text { color: hsl(var(--foreground)); font-weight: 500; }
          .step.completed .step-text { color: hsl(var(--muted-foreground)); }
          .error-container {
            display: none;
            text-align: center;
          }
          .error-icon {
            width: 2.5rem;
            height: 2.5rem;
            color: hsl(0 84.2% 60.2%);
            margin: 0 auto 1rem;
          }
          .error-title {
            font-size: 1rem;
            font-weight: 600;
            margin-bottom: 0.25rem;
          }
          .error-message {
            font-size: 0.875rem;
            color: hsl(var(--muted-foreground));
            margin-bottom: 1rem;
          }
          .error-link {
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
            font-size: 0.875rem;
            color: hsl(var(--foreground));
            text-decoration: none;
            padding: 0.5rem 1rem;
            border: 1px solid hsl(var(--border));
            border-radius: 0.375rem;
            transition: background-color 0.15s;
          }
          .error-link:hover {
            background-color: hsl(var(--muted-foreground) / 0.1);
          }`;

function wrapPage({
  title,
  extraHeadHtml = '',
  body,
  script = '',
}: {
  title: string;
  extraHeadHtml?: string;
  body: string;
  script?: string;
}): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">${extraHeadHtml}${GOOGLE_FONTS_LINKS}
        <title>${title}</title>
        <style>${SHARED_STYLE}
        </style>
      </head>
      <body>
        <div class="page-container">
          ${ROOMOTE_LOGO_MARKUP}
          ${body}
        </div>${script ? `\n        <script>\n${script}\n        </script>` : ''}
      </body>
    </html>
  `;
}

export function render404Page(taskId: string): string {
  return wrapPage({
    title: 'Preview Not Found',
    body: `<h1>Preview not found</h1>
        <p>This preview is correctly configured, but the environment for task <code>${escapeHtml(taskId)}</code> does not exist or is not available.</p>
        <p>This could mean:</p>
        <ul>
          <li>The task ID is incorrect</li>
          <li>The sandbox has not been created yet</li>
          <li>The task does not have a preview environment configured</li>
          <li>The specified port is not available</li>
          <li>This is just a test link to verify things work</li>
        </ul>
        <p><a href="${config.R_APP_URL}" class="button">← Go back home</a></p>`,
  });
}

export function renderUnavailablePage(taskId: string): string {
  return wrapPage({
    title: 'Preview Starting...',
    extraHeadHtml: `
        <meta http-equiv="refresh" content="5">`,
    body: `<h1>Preview starting...</h1>
        <p>The environment for <code>${escapeHtml(taskId)}</code> is being prepared.</p>
        <p>This page will refresh automatically.</p>
        <div class="spinner"></div>`,
  });
}

export function renderCompletedPage(taskId: string): string {
  return wrapPage({
    title: 'Preview Ended',
    body: `<h1>Preview Ended</h1>
        <p>The sandbox for task <code>${escapeHtml(taskId)}</code> has been terminated.</p>
        <p><a href="${config.R_APP_URL}/task/${escapeHtml(taskId)}" class="button">View task details →</a></p>`,
  });
}

export function renderResumingPage(
  taskId: string,
  resumeStatusId: string,
): string {
  return wrapPage({
    title: 'Resuming Preview...',
    body: `<div id="progress-container">
            <div class="header">
              <h1 class="title" id="title">Resuming Preview</h1>
              <p class="subtitle">Restoring sandbox for <code>${escapeHtml(taskId)}</code></p>
            </div>
            <div class="progress-steps" id="steps">
              <div class="step active" id="step-queue">
                <span class="step-icon">
                  <svg class="spinner" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <span class="step-text">Queuing resume task run</span>
              </div>
              <div class="step pending" id="step-create">
                <span class="step-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="8" stroke-dasharray="4 4" />
                  </svg>
                </span>
                <span class="step-text">Creating sandbox</span>
              </div>
              <div class="step pending" id="step-restore">
                <span class="step-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="8" stroke-dasharray="4 4" />
                  </svg>
                </span>
                <span class="step-text">Restoring workspace</span>
              </div>
              <div class="step pending" id="step-ready">
                <span class="step-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="8" stroke-dasharray="4 4" />
                  </svg>
                </span>
                <span class="step-text">Starting services</span>
              </div>
            </div>
          </div>
          <div class="error-container" id="error-container">
            <svg class="error-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <h2 class="error-title">Resume Failed</h2>
            <p class="error-message" id="error-text">Failed to resume sandbox.</p>
            <a class="error-link" href="${config.R_APP_URL}/task/${taskId}">
              View Task Details
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </a>
          </div>`,
    script: `          const resumeStatusId = ${JSON.stringify(resumeStatusId)};
          const checkInterval = 2000;
          let pollCount = 0;
          const maxPolls = 180;
          
          const spinnerSvg = '<svg class="spinner" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>';
          const checkSvg = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
          const pendingSvg = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8" stroke-dasharray="4 4"/></svg>';
          
          async function checkStatus() {
            pollCount++;
            if (pollCount > maxPolls) {
              showError('Timeout waiting for sandbox to start');
              return;
            }
            
            try {
              const res = await fetch('/rooproxy/resume-status/' + encodeURIComponent(resumeStatusId), {
                credentials: 'include'
              });
              
              if (!res.ok) {
                if (res.status === 401) {
                  window.location.reload();
                  return;
                }
                throw new Error('Failed to check status');
              }
              
              const data = await res.json();
              
              updateSteps(data.status);
              
              if (data.status === 'running' || data.status === 'idle') {
                setTimeout(() => window.location.reload(), 500);
              } else if (data.status === 'failed' || data.status === 'canceled') {
                showError(data.error || 'Resume task run failed');
              } else {
                setTimeout(checkStatus, checkInterval);
              }
            } catch (e) {
              console.error('Status check error:', e);
              setTimeout(checkStatus, checkInterval);
            }
          }
          
          function updateSteps(status) {
            const statusMap = {
              pending: 0,
              dequeued: 1,
              processing: 1,
              preparing: 2,
              spawning: 2,
              connecting: 3,
              running: 4,
              idle: 4,
            };
            const currentStep = statusMap[status] ?? 0;
            const stepIds = ['step-queue', 'step-create', 'step-restore', 'step-ready'];
            
            stepIds.forEach((id, i) => {
              const step = document.getElementById(id);
              const icon = step.querySelector('.step-icon');
              step.classList.remove('active', 'completed', 'pending');
              
              if (i < currentStep) {
                step.classList.add('completed');
                icon.innerHTML = checkSvg;
              } else if (i === currentStep) {
                step.classList.add('active');
                icon.innerHTML = spinnerSvg;
              } else {
                step.classList.add('pending');
                icon.innerHTML = pendingSvg;
              }
            });
          }
          
          function showError(message) {
            document.getElementById('progress-container').style.display = 'none';
            const errorContainer = document.getElementById('error-container');
            errorContainer.style.display = 'block';
            if (message) {
              document.getElementById('error-text').textContent = message;
            }
          }
          
          setTimeout(checkStatus, checkInterval);`,
  });
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char] || char);
}
