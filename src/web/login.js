'use strict';
(() => {
    const byId = (id) => document.getElementById(id);
    let setupRequired = false, busy = false;
    byId('server-address').textContent = location.host;
    function error(message) { byId('login-error').textContent = message || ''; byId('login-error').hidden = !message; }
    async function json(url, options) {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
        try { return await response.json(); } catch { throw new Error('The management service could not be reached. Reload this page and try again.'); }
    }
    function controls(disabled) {
        for (const input of document.querySelectorAll('input, button')) input.disabled = disabled;
        byId('sign-in').textContent = disabled ? 'Signing in…' : setupRequired ? 'Open setup' : 'Sign in';
    }
    byId('login-form').addEventListener('submit', async (event) => {
        event.preventDefault(); if (busy) return;
        const username = setupRequired ? 'setup' : byId('username').value;
        const password = setupRequired ? byId('setup-token').value.trim() : byId('password').value;
        if (!username || !password) { error(setupRequired ? 'Enter the setup access code.' : 'Enter your radio username and password.'); return; }
        busy = true; controls(true); error('');
        try {
            const result = await json('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
            byId('password').value = ''; byId('setup-token').value = '';
            if (!result.ok) { error(result.error || 'Sign in failed. Check your credentials and try again.'); return; }
            location.replace('/');
        } catch { error('Cannot reach the management service. Check the server connection and try again.'); }
        finally { busy = false; controls(false); }
    });
    (async () => {
        controls(true);
        try {
            const result = await json('/api/session');
            if (result.ok && result.value?.authenticated) { location.replace('/'); return; }
            setupRequired = Boolean(result.value?.setupRequired);
            byId('credentials-fields').hidden = setupRequired; byId('setup-fields').hidden = !setupRequired;
            byId('username').required = !setupRequired; byId('password').required = !setupRequired; byId('setup-token').required = setupRequired;
            byId('login-title').textContent = setupRequired ? 'Set up your splitter' : 'Sign in to your splitter';
            byId('login-description').textContent = setupRequired ? 'Your Linux service is ready. Enter its setup access code to add the radio connection.' : 'Use the username and password configured on your radio.';
        } catch { error('Cannot reach the management service. Reload this page to try again.'); }
        finally { controls(false); }
    })();
})();
