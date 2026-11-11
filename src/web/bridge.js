'use strict';
// Browser-only counterpart of the desktop preload. Authentication stays in a
// Secure HttpOnly cookie; the CSRF token exists only inside this closure.
(() => {
    let csrfToken = '', lastState = null, polling = false, stopped = false, timer, connectionError = false, lifecycle = 0, needsSession = false;
    const serviceNotice = 'Closing this browser leaves the splitter running. Start and Stop control only the radio connection.';
    const subscribers = new Set();
    async function json(url, options = {}) {
        const startedIn = lifecycle;
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
        let result;
        try { result = await response.json(); } catch { throw new Error('The management service returned an unreadable response.'); }
        let signedOut = response.status === 401;
        if (response.status === 403 && url !== '/api/session') {
            const sessionResponse = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
            const session = await sessionResponse.json();
            signedOut = Boolean(session.ok && session.value && !session.value.authenticated);
        }
        if (signedOut && lifecycle === startedIn) { stopped = true; clearInterval(timer); timer = null; location.replace('/login'); }
        return result;
    }
    async function verifySession() {
        const startedIn = lifecycle;
        const result = await json('/api/session');
        if (lifecycle !== startedIn || stopped) return false;
        if (!result.ok || !result.value?.authenticated) { stopped = true; clearInterval(timer); timer = null; location.replace('/login'); return false; }
        csrfToken = result.value.csrfToken || result.value.csrf;
        if (!csrfToken) throw new Error('The management session could not be verified. Sign in again.');
        return true;
    }
    function sessionCheck() {
        const startedIn = lifecycle;
        needsSession = false;
        return verifySession().catch((error) => { if (lifecycle === startedIn) needsSession = true; throw error; });
    }
    let ready = sessionCheck();
    function unavailable(error) {
        return { ok: false, error: error?.message || 'Cannot reach the management service. Check the server connection and try again.' };
    }
    async function serverRequest(action, payload) {
        const startedIn = lifecycle;
        if (needsSession && !stopped) ready = sessionCheck();
        if (!await ready || stopped || lifecycle !== startedIn) return { ok: false, error: 'Please sign in to the management service.' };
        const result = await json('/api/request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ action, ...(payload === undefined ? {} : { payload }) }) });
        if (result.ok && action === 'state' && lifecycle === startedIn && !stopped) lastState = result.value;
        return result;
    }
    function downloadReport(report) {
        const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob), anchor = document.createElement('a');
        anchor.href = url; anchor.download = `icom-splitter-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function importPasswordFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input'); input.type = 'file'; input.accept = '.txt,text/plain'; input.hidden = true;
            const finish = (result) => { input.remove(); resolve(result); };
            input.addEventListener('cancel', () => finish({ ok: true, value: null }), { once: true });
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                if (!file) { finish({ ok: true, value: null }); return; }
                if (file.size > 64) { finish({ ok: false, error: 'Choose a small text file containing only the radio password (up to 64 bytes).' }); return; }
                try {
                    const password = await file.text();
                    const field = document.getElementById('ICOM_PASSWORD');
                    if (!field) throw new Error('Open Settings before importing a password.');
                    field.value = password.replace(/\r?\n$/, '');
                    const source = document.getElementById('ICOM_PASSWORD_FILE'); if (source) source.value = '';
                    finish({ ok: true, value: null });
                } catch { finish({ ok: false, error: 'The selected password file could not be read.' }); }
            }, { once: true });
            document.body.append(input); input.click();
        });
    }
    async function request(action, payload) {
        try {
            if (action === 'close') return { ok: false, error: 'Closing this browser does not stop the Linux service. Use Stop to disconnect the radio.' };
            if (action === 'password-file') return importPasswordFile();
            const result = await serverRequest(action, payload);
            if (result.ok && action === 'export') { downloadReport(result.value); return { ok: true, value: true }; }
            setTimeout(applyBrowserLabels, 0); return result;
        } catch (error) { return unavailable(error); }
    }
    async function poll() {
        if (polling || stopped || !subscribers.size) return;
        polling = true; const startedIn = lifecycle;
        try {
            const result = await serverRequest('state');
            if (stopped || lifecycle !== startedIn) return;
            if (result.ok) { for (const callback of subscribers) callback(result.value); applyBrowserLabels(); if (connectionError) { showStatus(serviceNotice); connectionError = false; } }
            else { connectionError = true; showStatus(result.error || 'The connection to the management service needs attention.', true); }
        } catch { if (!stopped && lifecycle === startedIn) { connectionError = true; showStatus('Cannot reach the management service. Reload this page if the connection does not recover.', true); } }
        finally { polling = false; }
    }
    function text(id, value) { const node = document.getElementById(id); if (node && node.textContent !== value) node.textContent = value; }
    function showStatus(message, error = false) {
        const node = document.getElementById('web-status');
        if (node) { node.textContent = message; node.classList.toggle('error', error); }
    }
    function applyBrowserLabels() {
        const rail = document.querySelector('.rail-footer small');
        if (rail && rail.textContent !== 'LINUX MANAGEMENT') rail.textContent = 'LINUX MANAGEMENT';
        const tail = document.querySelector('.main-footer > span:last-child');
        if (tail && tail.id !== 'web-service-address' && tail.textContent !== 'History stays in this service session') tail.textContent = 'History stays in this service session';
        const subtitle = document.getElementById('page-subtitle');
        if (document.getElementById('page-title')?.textContent === 'Settings' && subtitle?.textContent !== 'Saved on the Linux server. Ready when its service restarts.') subtitle.textContent = 'Saved on the Linux server. Ready when its service restarts.';
        const uptimeNote = document.getElementById('uptime')?.nextElementSibling;
        if (uptimeNote && uptimeNote.textContent !== 'This service session') uptimeNote.textContent = 'This service session';
        text('setup-detail', 'Enter the same credentials you use for the radio. Settings are remembered on this Linux server.');
        const caption = document.getElementById('graph-caption');
        if (/history clears when you close the app/i.test(caption?.textContent || '')) caption.textContent = caption.textContent.replace(/history clears when you close the app/i, 'History clears when the management service restarts');
        const directory = document.getElementById('config-directory');
        if (directory?.textContent.startsWith('Configuration folder:')) directory.textContent = directory.textContent.replace('Configuration folder:', 'Server configuration folder:');
        if (lastState && !lastState.firstRun && !lastState.running && !lastState.connecting) text('connection-detail', 'The radio connection is stopped. Select Start splitter to connect using the saved server settings.');
    }
    async function logout() {
        const button = document.getElementById('web-signout'); button.disabled = true;
        try {
            if (!await ready) return;
            const result = await json('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: '{}' });
            if (!result.ok) throw new Error('Sign out failed.');
            csrfToken = ''; stopped = true; clearInterval(timer); subscribers.clear(); location.replace('/login');
        } catch { showStatus('Could not sign out. Check the connection and try again.', true); button.disabled = false; }
    }
    function setupBrowserControls() {
        const header = document.querySelector('.page-header'), footer = document.querySelector('.main-footer');
        if (header) {
            const button = document.createElement('button'); button.id = 'web-signout'; button.type = 'button'; button.className = 'button button-secondary'; button.textContent = 'Sign out'; button.addEventListener('click', logout); header.append(button);
        }
        if (footer) {
            const service = document.createElement('span'); service.id = 'web-service-address'; service.textContent = `Management: ${location.origin}`; footer.prepend(service);
        }
        const notice = document.createElement('div'); notice.id = 'web-status'; notice.className = 'message'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
        notice.textContent = serviceNotice;
        header?.after(notice); applyBrowserLabels();
        document.addEventListener('click', (event) => { if (event.target.closest?.('[data-view]')) window.scrollTo(0, 0); });
        const observer = new MutationObserver(applyBrowserLabels);
        const main = document.querySelector('main'); if (main) observer.observe(main, { childList: true, characterData: true, subtree: true });
    }
    window.splitter = Object.freeze({
        request,
        subscribe(callback) {
            subscribers.add(callback);
            if (!timer && !stopped) timer = setInterval(poll, 1000);
            void ready.then(() => poll()).catch((error) => showStatus(error.message, true));
            return () => { subscribers.delete(callback); if (!subscribers.size) { clearInterval(timer); timer = null; } };
        },
        onCloseConfirmation() { return () => {}; },
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupBrowserControls, { once: true });
    else setupBrowserControls();
    window.addEventListener('pagehide', () => { stopped = true; lifecycle++; clearInterval(timer); timer = null; });
    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        // A BFCache restore resumes this same heap. Its old CSRF token and
        // authenticated session may have expired while the page was frozen.
        stopped = false; csrfToken = ''; ready = sessionCheck();
        // Retain one retry source even if this session check fails transiently.
        // serverRequest retries authentication before any later state/action.
        if (subscribers.size && !timer) timer = setInterval(poll, 1000);
        void ready.then((authenticated) => {
            if (!authenticated || stopped || !subscribers.size) return;
            return poll();
        }).catch((error) => showStatus(error.message, true));
    });
})();
