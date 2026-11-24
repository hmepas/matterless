// Run with: node --test
// Black-box tests: a real proxy process in front of a fake upstream server.

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import zlib from 'node:zlib';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-proxy-test-'));
const dist = path.join(dir, 'dist');
const prevDist = `${dist}.prev`;
const layoutFile = path.join(dir, 'layout.json');
const logFile = path.join(dir, 'proxy.log');
const HASHED = 'main.0123456789abcdef0123.js';
const PREV_HASHED = 'chunk.fedcba9876543210abcd.js';

let upstream;
let upstreamPort;
let port;
let proxy;
let last;
let closeNextReused = false;
let resetOnceCount = 0;

const freePort = () => new Promise((resolve) => {
    const probe = net.createServer().listen(0, 'localhost', () => {
        const free = probe.address().port;
        probe.close(() => resolve(free));
    });
});

function startProxy(proxyPort, targetPort, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(import.meta.dirname, 'proxy.mjs')], {
            env: {
                PATH: process.env.PATH,
                MM_SERVICESETTINGS_SITEURL: `http://localhost:${targetPort}/`,
                MM_PROXY_PORT: String(proxyPort),
                MM_DIST_DIR: dist,
                MM_ALL_TEAMS_LAYOUT_FILE: layoutFile,
                MM_PROXY_LOG: logFile,
                MM_PROXY_POST_TIMEOUT_MS: '300',
                MM_SESSION_TOKEN: 'tok',
                MM_SESSION_USERID: 'uid',
                MM_SESSION_CSRF: 'csrf',
                ...extraEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.once('data', () => resolve(child));
        child.once('exit', (code) => reject(new Error(`proxy exited with ${code}`)));
    });
}

function rq({path: reqPath = '/', method = 'GET', headers = {}, body, toPort = port}) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: 'localhost', port: toPort, path: reqPath, method, agent: false, headers: {host: `localhost:${toPort}`, ...headers}}, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
        });
        req.on('error', reject);
        req.end(body);
    });
}

before(async () => {
    fs.mkdirSync(path.join(dist, 'files'), {recursive: true});
    fs.mkdirSync(prevDist, {recursive: true});
    fs.writeFileSync(path.join(dist, 'root.html'), '<html>app</html>');
    fs.writeFileSync(path.join(dist, HASHED), 'js');
    fs.writeFileSync(path.join(dist, 'remote_entry.js'), 'remote');
    fs.writeFileSync(path.join(prevDist, PREV_HASHED), 'prev-chunk');
    fs.writeFileSync(path.join(prevDist, 'old_unhashed.js'), 'unhashed');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');

    upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            last = {method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString()};
            if (closeNextReused && req.url === '/api/reuse-2') {
                closeNextReused = false;
                req.socket.destroy();
                return;
            }
            if (req.url === '/api/reset-once' && resetOnceCount === 0) {
                resetOnceCount += 1;
                req.socket.destroy();
                return;
            }
            if (req.url.startsWith('/api/v4/config/client')) {
                res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({SiteURL: 'https://real.example', WebsocketURL: 'wss://real.example', Version: '1'}));
            } else if (req.url === '/api/v4/system/ping') {
                res.writeHead(200, {'Content-Type': 'application/json'}).end('{"status":"OK"}');
            } else if (req.url === '/api/v4/users/login/desktop_token') {
                const body = JSON.parse(last.body || '{}');
                if (body.token === 'good-server-token') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Set-Cookie': [
                            'MMAUTHTOKEN=fresh-tok; Path=/; Domain=real.example; HttpOnly; Secure',
                            'MMUSERID=fresh-uid; Path=/; Domain=real.example; Secure',
                            'MMCSRF=fresh-csrf; Path=/; Domain=real.example; Secure',
                        ],
                    }).end('{"id":"fresh-uid"}');
                } else {
                    res.writeHead(401, {'Content-Type': 'application/json'}).end(JSON.stringify({id: 'app.desktop_token.validate.invalid', message: 'invalid'}));
                }
            } else if (req.url === '/api/v4/users/me') {
                if ((req.headers.cookie ?? '').includes('MMAUTHTOKEN=expired-tok')) {
                    res.writeHead(401, {'Content-Type': 'application/json'}).end(JSON.stringify({id: 'api.context.session_expired.app_error'}));
                } else {
                    res.writeHead(200, {'Content-Type': 'application/json'}).end('{"id":"uid"}');
                }
            } else if (req.url === '/api/v4/users/logout') {
                res.writeHead(200, {'Content-Type': 'application/json'}).end('{"status":"OK"}');
            } else if (req.url === '/api/cookies') {
                res.writeHead(200, {'Set-Cookie': ['A=1; Path=/; Domain=real.example; HttpOnly; Secure', 'B=2; Domain=.real.example']}).end();
            } else if (last.body.includes('"hang"')) {
                // Never answers.
            } else if (last.body.includes('"reject"')) {
                res.writeHead(500, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Request-Id': 'rq1'}).end(zlib.gzipSync(JSON.stringify({id: 'api.post.rejected', message: 'no'})));
            } else if (req.url === '/api/missing') {
                res.writeHead(404).end('nope');
            } else {
                res.writeHead(200, {'X-From': 'upstream', 'Content-Type': 'text/plain'}).end(`echo:${last.body}`);
            }
        });
    });
    upstream.on('upgrade', (req, socket) => {
        last = {url: req.url, headers: req.headers};
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
        socket.on('end', () => socket.end());
    });
    await new Promise((resolve) => upstream.listen(0, 'localhost', resolve));
    upstreamPort = upstream.address().port;
    port = await freePort();
    proxy = await startProxy(port, upstreamPort);
});

after(() => {
    proxy.removeAllListeners('exit');
    proxy.kill();
    upstream.closeAllConnections();
    upstream.close();
    fs.rmSync(dir, {recursive: true, force: true});
});

test('a foreign Host header is refused everywhere and gets no cookies', async () => {
    for (const reqPath of ['/', '/__auth', '/__all_teams_layout', '/api/x', `/static/${HASHED}`]) {
        const res = await rq({path: reqPath, headers: {host: 'evil.example', accept: 'text/html'}});
        assert.equal(res.status, 403, reqPath);
        assert.equal(res.headers['set-cookie'], undefined);
    }
});

test('app routes get root.html, assets and unknown files do not', async () => {
    const page = await rq({path: '/team/channels/town-square', headers: {accept: 'text/html'}});
    assert.equal(page.status, 200);
    assert.equal(page.body, '<html>app</html>');
    assert.equal(page.headers['cache-control'], 'no-cache');

    assert.equal((await rq({path: '/team/channels/x', headers: {accept: 'application/json'}})).status, 404);
    assert.equal((await rq({path: '/favicon.ico', headers: {accept: 'text/html'}})).status, 404);
});

test('session cookies are set only when the token differs', async () => {
    const fresh = await rq({headers: {accept: 'text/html'}});
    assert.deepEqual(fresh.headers['set-cookie'], [
        'MMAUTHTOKEN=tok; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly',
        'MMUSERID=uid; Path=/; Max-Age=2592000; SameSite=Lax',
        'MMCSRF=csrf; Path=/; Max-Age=2592000; SameSite=Lax',
    ]);
    assert.equal((await rq({headers: {accept: 'text/html', cookie: 'x=1; MMAUTHTOKEN=tok'}})).headers['set-cookie'], undefined);
    assert.equal((await rq({headers: {accept: 'text/html', cookie: 'MMAUTHTOKEN=old'}})).headers['set-cookie'].length, 3);
    assert.equal((await rq({path: `/static/${HASHED}`, headers: {accept: 'text/html'}})).headers['set-cookie'], undefined);
});

test('static files: types, caching, no escape from dist', async () => {
    const hashed = await rq({path: `/static/${HASHED}`});
    assert.equal(hashed.status, 200);
    assert.match(hashed.headers['content-type'], /javascript/);
    assert.match(hashed.headers['cache-control'], /immutable/);
    assert.equal((await rq({path: '/static/remote_entry.js'})).headers['cache-control'], 'no-cache');

    assert.equal((await rq({path: '/static/nope.js'})).status, 404);
    assert.match(await logLineWith('GET /static/nope.js status=404'), /status=404$/);
    assert.equal((await rq({path: '/static/files'})).status, 404);
    assert.equal((await rq({path: '/static/../secret.txt'})).status, 404);
    assert.equal((await rq({path: '/static/%2e%2e/secret.txt'})).status, 404);
    assert.equal((await rq({path: '/static/%'})).status, 400);

    // Content-hashed chunks from the previous build still load for tabs opened before a rebuild.
    const fromPrev = await rq({path: `/static/${PREV_HASHED}`});
    assert.equal(fromPrev.status, 200);
    assert.equal(fromPrev.body, 'prev-chunk');
    assert.match(fromPrev.headers['cache-control'], /immutable/);
    assert.equal((await rq({path: '/static/old_unhashed.js'})).status, 404);
});

test('API requests are forwarded with the real host and origin', async () => {
    const res = await rq({
        path: '/api/v4/posts?x=1',
        method: 'POST',
        headers: {origin: `http://localhost:${port}`, cookie: 'MMAUTHTOKEN=tok', 'x-csrf-token': 'csrf', 'content-type': 'application/json'},
        body: '{"a":1}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'echo:{"a":1}');
    assert.equal(res.headers['x-from'], 'upstream');
    assert.equal(last.method, 'POST');
    assert.equal(last.url, '/api/v4/posts?x=1');
    assert.equal(last.headers.host, `localhost:${upstreamPort}`);
    assert.equal(last.headers.origin, `http://localhost:${upstreamPort}`);
    assert.equal(last.headers.cookie, 'MMAUTHTOKEN=tok');
    assert.equal(last.headers['x-csrf-token'], 'csrf');
    assert.equal(last.headers['x-forwarded-proto'], 'http');
});

test('large uploads and upstream error statuses pass through', async () => {
    const big = crypto.randomBytes(2 * 1024 * 1024).toString('hex');
    assert.equal((await rq({path: '/api/v4/files', method: 'POST', body: big})).body, `echo:${big}`);
    const missing = await rq({path: '/api/missing'});
    assert.equal(missing.status, 404);
    assert.equal(missing.body, 'nope');
});

test('every proxied prefix reaches upstream, lookalikes do not', async () => {
    for (const reqPath of ['/plugins/x/y', '/static/plugins/p.js', '/oauth/gitlab/complete']) {
        const res = await rq({path: reqPath});
        assert.equal(res.headers['x-from'], 'upstream', reqPath);
    }
    assert.notEqual((await rq({path: '/apiary'})).headers['x-from'], 'upstream');
});

test('Domain is stripped from upstream cookies', async () => {
    assert.deepEqual((await rq({path: '/api/cookies'})).headers['set-cookie'], ['A=1; Path=/; HttpOnly', 'B=2']);
});

test('SiteURL and WebsocketURL are rewritten to the proxy so the app and its websocket stay on localhost, the real SiteURL is kept for shared links', async () => {
    const res = await rq({path: '/api/v4/config/client?format=old', headers: {'accept-encoding': 'gzip'}});
    assert.equal(last.headers['accept-encoding'], undefined);
    assert.deepEqual(JSON.parse(res.body), {SiteURL: `http://localhost:${port}`, WebsocketURL: `ws://localhost:${port}`, ProxyUpstreamSiteURL: 'https://real.example', Version: '1'});
    assert.equal(Number(res.headers['content-length']), res.body.length);
});

function openSocket(headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: 'localhost', port, path: '/api/v4/websocket', agent: false, headers: {host: `localhost:${port}`, connection: 'Upgrade', upgrade: 'websocket', ...headers}});
        req.on('upgrade', (res, socket) => resolve({status: res.statusCode, socket}));
        req.on('response', (res) => {
            res.resume();
            resolve({status: res.statusCode});
        });
        req.on('error', reject);
        req.end();
    });
}

test('websockets pass both ways with the real origin', async () => {
    const {status, socket} = await openSocket({origin: `http://localhost:${port}`});
    assert.equal(status, 101);
    assert.equal(last.headers.origin, `http://localhost:${upstreamPort}`);
    const reply = new Promise((resolve) => socket.once('data', (chunk) => resolve(chunk.toString())));
    socket.write('hi');
    assert.equal(await reply, 'echo:hi');
    socket.destroy();
    assert.match(await logLineWith('ws close after_s='), /by=client$/);
});

test('websockets from another origin or host are refused', async () => {
    assert.equal((await openSocket({origin: 'https://evil.example'})).status, 403);
    assert.equal((await openSocket({host: 'evil.example'})).status, 403);
});

test('a keep-alive connection closed by upstream is retried for GET', async () => {
    const agent = new http.Agent({keepAlive: true});
    const get = (reqPath) => new Promise((resolve, reject) => {
        http.get({host: 'localhost', port, path: reqPath, agent, headers: {host: `localhost:${port}`}}, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
    assert.equal(await get('/api/reuse-1'), 200);
    closeNextReused = true;
    assert.equal(await get('/api/reuse-2'), 200);
    resetOnceCount = 0;
    assert.equal((await rq({path: '/api/reset-once'})).status, 200);
    agent.destroy();
});

test('layout: stored, validated, same-origin only, and kept across restarts', async () => {
    const url = '/__all_teams_layout';
    const json = {'content-type': 'application/json'};
    const layout = JSON.stringify({groups: [{id: 'default', channelIds: ['a']}]});

    assert.equal((await rq({path: url})).status, 204);
    assert.equal((await rq({path: url, method: 'PUT', headers: {...json, origin: `http://localhost:${port}`}, body: layout})).status, 204);
    assert.equal((await rq({path: url, method: 'PUT', headers: json, body: '{"groups":[]}'})).status, 400);
    assert.equal((await rq({path: url, method: 'PUT', headers: json, body: '{oops'})).status, 400);
    assert.equal((await rq({path: url, method: 'PUT', headers: {...json, origin: 'https://evil.example'}, body: layout})).status, 403);
    assert.equal((await rq({path: url, method: 'PUT', headers: {'content-type': 'text/plain'}, body: layout})).status, 403);
    assert.equal((await rq({path: url, method: 'PUT', headers: json, body: 'x'.repeat(6 * 1024 * 1024)})).status, 413);
    assert.equal((await rq({path: url, method: 'DELETE'})).status, 405);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);

    const otherPort = await freePort();
    const restarted = await startProxy(otherPort, upstreamPort);
    assert.deepEqual(JSON.parse((await rq({path: url, toPort: otherPort})).body), JSON.parse(layout));
    restarted.removeAllListeners('exit');
    restarted.kill();
});

test('/__auth sets cookies from the form, same-origin only', async () => {
    const form = {'content-type': 'application/x-www-form-urlencoded'};
    assert.equal((await rq({path: '/__auth'})).status, 200);

    const done = await rq({path: '/__auth', method: 'POST', headers: {...form, origin: `http://localhost:${port}`}, body: 'MMAUTHTOKEN=t&MMUSERID=u&MMCSRF=c'});
    assert.equal(done.status, 302);
    assert.equal(done.headers.location, '/');
    assert.equal(done.headers['set-cookie'].length, 3);

    assert.equal((await rq({path: '/__auth', method: 'POST', headers: form, body: 'MMAUTHTOKEN=t'})).status, 400);
    assert.equal((await rq({path: '/__auth', method: 'POST', headers: {...form, origin: 'https://evil.example'}, body: 'MMAUTHTOKEN=t&MMUSERID=u&MMCSRF=c'})).status, 403);
});

test('an unreachable upstream gives 502 on API and HTML pages without setting cookies, the proxy survives', async () => {
    const otherPort = await freePort();
    const child = await startProxy(otherPort, await freePort());
    assert.equal((await rq({path: '/api/x', toPort: otherPort})).status, 502);
    const page = await rq({path: '/', headers: {accept: 'text/html'}, toPort: otherPort});
    assert.equal(page.status, 502);
    assert.equal(page.headers['set-cookie'], undefined);
    assert.equal(page.headers['retry-after'], '5');
    assert.match(page.body, /http-equiv="refresh"/);
    assert.equal((await rq({path: `/static/${HASHED}`, toPort: otherPort})).status, 200);
    child.removeAllListeners('exit');
    child.kill();
});

test('/__auth/desktop exchanges a desktop server_token, persists the session, and clears it on expiry or logout', async () => {
    const sessionFile = path.join(dir, 'session.json');
    const otherPort = await freePort();
    const child = await startProxy(otherPort, upstreamPort, {MM_SESSION_FILE: sessionFile});
    const form = {'content-type': 'application/x-www-form-urlencoded'};
    try {
        // Prefill via ?url= is HTML-escaped.
        const prefilled = await rq({path: '/__auth?url=' + encodeURIComponent('https://real.example/login/desktop?server_token=abc&x="><script>'), toPort: otherPort});
        assert.equal(prefilled.status, 200);
        assert.doesNotMatch(prefilled.body, /"><script>/);
        assert.match(prefilled.body, /server_token=abc/);

        // Foreign origin and missing/invalid tokens are rejected.
        assert.equal((await rq({path: '/__auth/desktop', method: 'POST', headers: {...form, origin: 'https://evil.example'}, body: 'token=good-server-token', toPort: otherPort})).status, 403);
        assert.equal((await rq({path: '/__auth/desktop', method: 'POST', headers: form, body: 'token=https://real.example/no-token', toPort: otherPort})).status, 400);
        assert.equal((await rq({path: '/__auth/desktop', method: 'POST', headers: form, body: 'token=bad-token', toPort: otherPort})).status, 401);

        // Full redirect URL is accepted and exchanged for a persisted session.
        const fullUrl = 'https://real.example/login/desktop?server_token=good-server-token&client_token=abc';
        const ok = await rq({path: '/__auth/desktop', method: 'POST', headers: {...form, origin: `http://localhost:${otherPort}`}, body: `token=${encodeURIComponent(fullUrl)}`, toPort: otherPort});
        assert.equal(ok.status, 302);
        assert.equal(ok.headers.location, '/');
        assert.deepEqual(ok.headers['set-cookie'], [
            'MMAUTHTOKEN=fresh-tok; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly',
            'MMUSERID=fresh-uid; Path=/; Max-Age=2592000; SameSite=Lax',
            'MMCSRF=fresh-csrf; Path=/; Max-Age=2592000; SameSite=Lax',
        ]);
        assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);

        // Reloading the page keeps the fresh session (never clobbered by env tok).
        const reload = await rq({headers: {accept: 'text/html', cookie: 'MMAUTHTOKEN=fresh-tok'}, toPort: otherPort});
        assert.equal(reload.status, 200);
        assert.equal(reload.headers['set-cookie'], undefined);
    } finally {
        child.removeAllListeners('exit');
        child.kill();
    }

    // Restarting picks up sessionFile over env MM_SESSION_TOKEN.
    const restartedPort = await freePort();
    const restarted = await startProxy(restartedPort, upstreamPort, {MM_SESSION_FILE: sessionFile});
    try {
        const page = await rq({headers: {accept: 'text/html'}, toPort: restartedPort});
        assert.match(page.headers['set-cookie'][0], /^MMAUTHTOKEN=fresh-tok;/);

        // Logout clears the persisted session so reloads don't re-inject it.
        const out = await rq({path: '/api/v4/users/logout', method: 'POST', headers: {cookie: 'MMAUTHTOKEN=fresh-tok'}, toPort: restartedPort});
        assert.equal(out.status, 200);
        assert.equal(fs.existsSync(sessionFile), false);
        const afterLogout = await rq({headers: {accept: 'text/html'}, toPort: restartedPort});
        assert.equal(afterLogout.headers['set-cookie'], undefined);

        // Direct API login (used by webapp's Login page) also captures & persists the session.
        const apiLogin = await rq({
            path: '/api/v4/users/login/desktop_token',
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({token: 'good-server-token', deviceId: ''}),
            toPort: restartedPort,
        });
        assert.equal(apiLogin.status, 200);
        assert.equal(fs.existsSync(sessionFile), true);
        assert.match(apiLogin.headers['set-cookie'][0], /^MMAUTHTOKEN=fresh-tok;/);
        assert.doesNotMatch(apiLogin.headers['set-cookie'][0], /Secure/i);
    } finally {
        restarted.removeAllListeners('exit');
        restarted.kill();
    }

    // Expired session (401 on /api/v4/users/me) clears the active session so it is not re-injected.
    const expPort = await freePort();
    const expChild = await startProxy(expPort, upstreamPort, {MM_SESSION_TOKEN: 'expired-tok', MM_SESSION_USERID: 'u', MM_SESSION_CSRF: 'c'});
    try {
        const me = await rq({path: '/api/v4/users/me', headers: {cookie: 'MMAUTHTOKEN=expired-tok'}, toPort: expPort});
        assert.equal(me.status, 401);
        const afterExpiry = await rq({headers: {accept: 'text/html'}, toPort: expPort});
        assert.equal(afterExpiry.headers['set-cookie'], undefined);
    } finally {
        expChild.removeAllListeners('exit');
        expChild.kill();
    }
});

test('MM_PROXY_SSO_PROVIDERS configures SSO buttons in client config and /__auth, ignoring unsafe paths', async () => {
    const otherPort = await freePort();
    const child = await startProxy(otherPort, upstreamPort, {
        MM_PROXY_SSO_PROVIDERS: 'Corporate SSO=/oauth/openid/login, Guest=/oauth/custom/login, Evil=https://evil.example/login, Proto=//evil.example/x',
    });
    try {
        const cfgRes = await rq({path: '/api/v4/config/client?format=old', toPort: otherPort});
        const cfg = JSON.parse(cfgRes.body);
        assert.deepEqual(JSON.parse(cfg.ProxySsoProviders), [
            {label: 'Corporate SSO', path: '/oauth/openid/login'},
            {label: 'Guest', path: '/oauth/custom/login'},
        ]);

        const authPage = await rq({path: '/__auth', toPort: otherPort});
        assert.equal(authPage.status, 200);
        assert.match(authPage.body, /Corporate SSO/);
        assert.match(authPage.body, /\/oauth\/openid\/login/);
        assert.match(authPage.body, /Guest/);
        assert.doesNotMatch(authPage.body, /evil\.example/);
    } finally {
        child.removeAllListeners('exit');
        child.kill();
    }
});

test('a busy port fails with a clear exit, not a hang', async () => {
    await assert.rejects(startProxy(port, upstreamPort), /exited with 1/);
});

const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

async function logLineWith(text) {
    for (let i = 0; i < 100; i++) {
        const line = readLog().split('\n').find((candidate) => candidate.includes(text));
        if (line) {
            return line;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no log line with ${text}`);
}

const sendPost = (pendingId, message) => rq({
    path: '/api/v4/posts',
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({pending_post_id: pendingId, channel_id: 'chan1', root_id: '', message, file_ids: []}),
});

test('a sent post is logged with its ids and without its text', async () => {
    assert.equal((await sendPost('p:ok', 'top secret text')).status, 200);
    const line = await logLineWith('pending_post_id=p:ok');
    assert.match(line, /POST \/api\/v4\/posts status=200 ms=\d+ pending_post_id=p:ok channel_id=chan1$/);
    assert.doesNotMatch(readLog(), /top secret/);
});

test('a rejected post is logged with the server error id, not the message', async () => {
    assert.equal((await sendPost('p:rejected', 'reject')).status, 500);
    assert.match(await logLineWith('pending_post_id=p:rejected'), /status=500 ms=\d+ err=api\.post\.rejected request_id=rq1 /);
});

test('a post with no answer fails with 504 instead of hanging', async () => {
    assert.equal((await sendPost('p:hang', 'hang')).status, 504);
    assert.match(await logLineWith('pending_post_id=p:hang'), /status=504 .*upstream=ETIMEDOUT/);
});

test('successful reads stay out of the log', async () => {
    await rq({path: '/api/quiet-read'});
    await rq({path: '/api/missing'});
    await sendPost('p:marker', 'x');
    await logLineWith('pending_post_id=p:marker');
    assert.doesNotMatch(readLog(), /quiet-read|\/api\/missing/);
});

test('page reports are logged with known fields only, and neutralized', async () => {
    const send = (body, headers = {'content-type': 'application/json'}) => rq({path: '/__client_log', method: 'POST', headers, body});
    assert.equal((await send(JSON.stringify({event: 'post_failed', pending_post_id: 'p:c', server_error_id: 'evil\n2026 forged line', message: 'top secret'}))).status, 204);
    const line = await logLineWith('client event=post_failed');
    assert.match(line, /pending_post_id=p:c server_error_id=evil_2026_forged_line$/);
    assert.doesNotMatch(readLog(), /^2026 forged/m);
    assert.doesNotMatch(readLog(), /top secret/);

    assert.equal((await send(JSON.stringify({event: 'chunk_load_error', component: 'PermalinkView', error: 'ChunkLoadError', route: '/team/pl/abc'}))).status, 204);
    assert.match(await logLineWith('client event=chunk_load_error'), /component=PermalinkView error=ChunkLoadError route=\/team\/pl\/abc$/);

    assert.equal((await send('{', {'content-type': 'application/json'})).status, 400);
    assert.equal((await send('{}', {'content-type': 'text/plain'})).status, 403);
    assert.equal((await send('{}', {'content-type': 'application/json', origin: 'https://evil.example'})).status, 403);
    assert.equal((await rq({path: '/__client_log'})).status, 405);
});

test('the log is private to the user', () => {
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});
