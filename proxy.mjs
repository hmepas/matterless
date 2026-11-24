#!/usr/bin/env node
// Serves the patched Mattermost webapp from dist/ on localhost and forwards everything server-side
// to the real Mattermost server. No dependencies: Node's standard library only.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';

const {
    MM_SERVICESETTINGS_SITEURL: siteUrl,
    MM_PROXY_PORT: portEnv,
    MM_DIST_DIR: distEnv,
    MM_ALL_TEAMS_LAYOUT_FILE: layoutFile,
    MM_SESSION_FILE: sessionFileEnv,
    MM_PROXY_LOG: logEnv,
    MM_PROXY_POST_TIMEOUT_MS: postTimeoutEnv,
    MM_PROXY_PING_TIMEOUT_MS: pingTimeoutEnv,
    MM_PROXY_SSO_PROVIDERS: ssoProvidersEnv,
    MM_SESSION_TOKEN: sessionToken,
    MM_SESSION_USERID: sessionUserId,
    MM_SESSION_CSRF: sessionCsrf,
} = process.env;

if (!siteUrl) {
    console.error('set MM_SERVICESETTINGS_SITEURL=https://your-mattermost-host');
    process.exit(1);
}

const target = new URL(siteUrl);
const port = Number(portEnv) || 9005;
const distDir = path.resolve(distEnv || path.join(import.meta.dirname, 'dist'));
const prevDistDir = `${distDir}.prev`;
const ownHost = `localhost:${port}`;
const ownOrigin = `http://${ownHost}`;

if (!fs.existsSync(path.join(distDir, 'root.html'))) {
    console.error(`no build in ${distDir}: run ./build.sh`);
    process.exit(1);
}

const PROXIED_PREFIXES = ['/api', '/plugins', '/static/plugins', '/oauth'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const COOKIE_NAMES = ['MMAUTHTOKEN', 'MMUSERID', 'MMCSRF'];
const CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.eot': 'application/vnd.ms-fontobject',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.mp3': 'audio/mpeg',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const CLIENT_LOG_FIELDS = ['event', 'pending_post_id', 'channel_id', 'root_id', 'status_code', 'server_error_id', 'online', 'ws', 'component', 'error', 'route'];
const HASHED_ASSET = /\.[0-9a-f]{16,}\./;
const POST_BODY_LOG_FIELDS = ['pending_post_id', 'channel_id', 'root_id'];
const MAX_LOGGED_BODY_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

// A post that gets no answer has to end up as failed in the UI, not as pending forever. Resending is
// safe: the server recognizes a repeated pending_post_id.
const postTimeoutMs = Number(postTimeoutEnv) || 30000;
const pingTimeoutMs = Number(pingTimeoutEnv) || 5000;
const sessionFile = sessionFileEnv ? path.resolve(sessionFileEnv) : '';
let tmpCounter = 0;

function parseSsoProviders(raw) {
    if (!raw) {
        return [];
    }
    const providers = [];
    for (const item of String(raw).split(',')) {
        const trimmed = item.trim();
        if (!trimmed) {
            continue;
        }
        const eq = trimmed.indexOf('=');
        const label = eq > 0 ? trimmed.slice(0, eq).trim() : trimmed;
        const oauthPath = eq > 0 ? trimmed.slice(eq + 1).trim() : trimmed;
        if (!oauthPath.startsWith('/') || oauthPath.startsWith('//')) {
            continue;
        }
        providers.push({label: label || oauthPath, path: oauthPath});
    }
    return providers;
}

const ssoProviders = parseSsoProviders(ssoProvidersEnv);

const logFile = path.resolve(logEnv || path.join(import.meta.dirname, 'proxy.log'));
let logSize = 0;
try {
    logSize = fs.statSync(logFile).size;
} catch {
    // No log yet.
}

// For sending the file to someone, so it holds ids and statuses only: never a message text, a cookie
// or a token. Everything logged from a request has to pass through logValue().
function log(line) {
    const text = `${new Date().toISOString()} ${line}\n`;
    console.log(text.trimEnd());
    try {
        if (logSize + text.length > MAX_LOG_BYTES) {
            fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
            logSize = 0;
        }
        fs.appendFileSync(logFile, text, {mode: 0o600});
        logSize += text.length;
    } catch (error) {
        console.error(`can't write ${logFile}: ${error.message}`);
    }
}

function logValue(value) {
    return String(value).replace(/[^\w:./-]+/g, '_').slice(0, 200);
}

const transport = target.protocol === 'https:' ? https : http;
const keepAliveAgent = new transport.Agent({keepAlive: true});

function cookieFromHeader(header, name) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header ?? '');
    if (!match) {
        return '';
    }
    try {
        return decodeURIComponent(match[1]).trim();
    } catch {
        return match[1].trim();
    }
}

function cookiesFromSetCookie(setCookieHeaders) {
    if (!Array.isArray(setCookieHeaders)) {
        return null;
    }
    const found = {};
    for (const header of setCookieHeaders) {
        const pair = header.split(';', 1)[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const name = pair.slice(0, eq).trim();
        if (COOKIE_NAMES.includes(name)) {
            const raw = pair.slice(eq + 1).trim();
            try {
                found[name] = decodeURIComponent(raw).trim();
            } catch {
                found[name] = raw;
            }
        }
    }
    return COOKIE_NAMES.every((name) => found[name]) ? found : null;
}

function loadInitialSession() {
    if (sessionFile) {
        try {
            const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            if (COOKIE_NAMES.every((name) => typeof parsed?.[name] === 'string' && parsed[name].trim())) {
                return Object.fromEntries(COOKIE_NAMES.map((name) => [name, parsed[name].trim()]));
            }
        } catch {
            // No stored session yet; fall back to env.
        }
    }
    if (sessionToken && sessionUserId && sessionCsrf) {
        return {
            MMAUTHTOKEN: sessionToken.trim(),
            MMUSERID: sessionUserId.trim(),
            MMCSRF: sessionCsrf.trim(),
        };
    }
    return null;
}

let activeSession = loadInitialSession();

function saveSession(values) {
    const normalized = Object.fromEntries(COOKIE_NAMES.map((name) => [name, values[name].trim()]));
    const unchanged = activeSession && COOKIE_NAMES.every((name) => activeSession[name] === normalized[name]);
    activeSession = normalized;
    if (sessionFile) {
        const tmpFile = `${sessionFile}.${process.pid}.${tmpCounter++}.tmp`;
        try {
            fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), {mode: 0o600});
            fs.renameSync(tmpFile, sessionFile);
        } catch (error) {
            console.error(`can't write ${sessionFile}: ${error.message}`);
            try {
                fs.unlinkSync(tmpFile);
            } catch {
                // Ignore cleanup failure.
            }
        }
    }
    if (!unchanged) {
        log('session updated');
    }
}

function clearSession(reason) {
    if (!activeSession) {
        return;
    }
    activeSession = null;
    if (sessionFile) {
        try {
            fs.unlinkSync(sessionFile);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`can't remove ${sessionFile}: ${error.message}`);
            }
        }
    }
    log(`session cleared reason=${logValue(reason)}`);
}

function isOwnOrigin(req) {
    return !req.headers.origin || req.headers.origin === ownOrigin;
}

function pathOf(req) {
    return req.url.split('?')[0];
}

function isProxied(pathname) {
    return PROXIED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isPostCreate(req) {
    return req.method === 'POST' && pathOf(req) === '/api/v4/posts';
}

function teeBody(stream, limit) {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
        size += chunk.length;
        if (size <= limit) {
            chunks.push(chunk);
        }
    });
    return () => (size <= limit ? Buffer.concat(chunks) : null);
}

function postLogFields(body) {
    try {
        const post = JSON.parse(body.toString('utf8'));
        return POST_BODY_LOG_FIELDS.filter((name) => post[name]).map((name) => `${name}=${logValue(post[name])}`);
    } catch {
        return ['body=unparsable'];
    }
}

function errorIdOf(body, encoding) {
    try {
        let plain = body;
        if (encoding === 'gzip') {
            plain = zlib.gunzipSync(body);
        } else if (encoding === 'deflate') {
            plain = zlib.inflateSync(body);
        } else if (encoding === 'br') {
            plain = zlib.brotliDecompressSync(body);
        }
        return JSON.parse(plain.toString('utf8')).id;
    } catch {
        return undefined;
    }
}

// One line per sent post and per failed request, written when the exchange is over.
function startAudit(req, res) {
    const started = Date.now();
    const audit = {};
    const getPostBody = isPostCreate(req) ? teeBody(req, MAX_LOGGED_BODY_BYTES) : null;

    res.once('close', () => {
        const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
        const clientClosed = !res.writableFinished;
        const status = res.headersSent ? res.statusCode : 0;
        const isMeAuthError = pathOf(req) === '/api/v4/users/me' && status === 401;
        if (!getPostBody && !audit.upstreamError && !isMeAuthError && status < 500 && !(isWrite && (clientClosed || status >= 400))) {
            return;
        }

        const fields = [`status=${status || 'none'}`, `ms=${Date.now() - started}`];
        if (clientClosed) {
            fields.push('client-closed');
        }
        if (audit.upstreamError) {
            fields.push(`upstream=${logValue(audit.upstreamError)}`);
        }
        const errorId = audit.getErrorBody && errorIdOf(audit.getErrorBody() ?? Buffer.alloc(0), audit.encoding);
        if (errorId) {
            fields.push(`err=${logValue(errorId)}`);
        }
        if (audit.requestId) {
            fields.push(`request_id=${logValue(audit.requestId)}`);
        }
        const postBody = getPostBody?.();
        if (postBody) {
            fields.push(...postLogFields(postBody));
        }
        log(`${req.method} ${logValue(pathOf(req))} ${fields.join(' ')}`);
    });
    return audit;
}

function upstreamOptions(req, headers, agent) {
    return {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: req.method,
        path: req.url,
        headers,
        agent,
    };
}

function upstreamHeaders(req) {
    const headers = {...req.headers};
    headers.host = target.host;

    // The real server's same-origin check has to see its own origin.
    if (headers.origin) {
        headers.origin = target.origin;
    }

    const forwardedFor = headers['x-forwarded-for'];
    headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-port'] = String(port);
    headers['x-forwarded-proto'] = 'http';
    return headers;
}

function clientHeaders(upstreamResponse) {
    const headers = {...upstreamResponse.headers};
    HOP_BY_HOP.forEach((name) => delete headers[name]);

    // Without Domain/Secure attributes, session cookies stick to http://localhost.
    if (headers['set-cookie']) {
        headers['set-cookie'] = headers['set-cookie'].map((cookie) => (
            cookie.replace(/;\s*domain=[^;]*/i, '').replace(/;\s*secure\b/i, '')
        ));
    }
    return headers;
}

// The desktop app replaces the server URL with the SiteURL it reads from the client config, which
// would send it back to the real server. Report this proxy as the SiteURL instead, and keep the real
// one in ProxyUpstreamSiteURL so that links the webapp shares with other people point at the server.
// The server also names its own WebsocketURL, which would take the websocket around the proxy and
// out of its log: point that at the proxy too.
function relayClientConfig(upstreamResponse, res) {
    const chunks = [];
    upstreamResponse.on('data', (chunk) => chunks.push(chunk));
    upstreamResponse.on('end', () => {
        const headers = clientHeaders(upstreamResponse);
        let body = Buffer.concat(chunks);
        try {
            const config = JSON.parse(body.toString('utf8'));
            config.ProxyUpstreamSiteURL = config.SiteURL || target.origin;
            if (ssoProviders.length > 0) {
                config.ProxySsoProviders = JSON.stringify(ssoProviders);
            }
            config.SiteURL = ownOrigin;
            config.WebsocketURL = ownOrigin.replace(/^http/, 'ws');
            body = Buffer.from(JSON.stringify(config));
            headers['content-length'] = body.length;
        } catch {
            console.error('client config is not plain JSON: SiteURL was not rewritten');
        }
        res.writeHead(upstreamResponse.statusCode, headers);
        res.end(body);
    });
}

function proxyRequest(req, res, audit = startAudit(req, res), isRetry = false) {
    const isBodiless = req.method === 'GET' || req.method === 'HEAD';
    const pathname = pathOf(req);
    const isClientConfig = pathname.startsWith('/api/v4/config/client');
    const requestToken = cookieFromHeader(req.headers.cookie, 'MMAUTHTOKEN');

    const headers = upstreamHeaders(req);
    HOP_BY_HOP.forEach((name) => delete headers[name]);
    if (isClientConfig) {
        delete headers['accept-encoding'];
    }

    // Only requests that can safely be resent reuse connections: the server may close an idle one
    // at the moment a request goes out on it. Retries always open a fresh socket.
    const upstream = transport.request(upstreamOptions(req, headers, isBodiless && !isRetry ? keepAliveAgent : false));

    const abortUpstream = () => {
        if (!res.writableFinished) {
            upstream.destroy();
        }
    };
    res.once('close', abortUpstream);

    if (isPostCreate(req)) {
        upstream.setTimeout(postTimeoutMs, () => upstream.destroy(Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})));
    }

    upstream.on('response', (upstreamResponse) => {
        audit.requestId = upstreamResponse.headers['x-request-id'];
        if (upstreamResponse.statusCode >= 400) {
            audit.encoding = upstreamResponse.headers['content-encoding'];
            audit.getErrorBody = teeBody(upstreamResponse, MAX_LOGGED_BODY_BYTES);
        }
        if (upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300) {
            const newSession = cookiesFromSetCookie(upstreamResponse.headers['set-cookie']);
            if (newSession) {
                saveSession(newSession);
            }
        }
        if (req.method === 'POST' && pathname === '/api/v4/users/logout' && upstreamResponse.statusCode < 500) {
            if (activeSession && (!requestToken || requestToken === activeSession.MMAUTHTOKEN)) {
                clearSession('logout');
            }
        } else if (pathname === '/api/v4/users/me' && upstreamResponse.statusCode === 401) {
            if (activeSession && requestToken === activeSession.MMAUTHTOKEN) {
                clearSession('expired');
            }
        }
        if (isClientConfig && upstreamResponse.statusCode === 200) {
            relayClientConfig(upstreamResponse, res);
            return;
        }
        res.writeHead(upstreamResponse.statusCode, clientHeaders(upstreamResponse));
        upstreamResponse.pipe(res);
    });

    upstream.on('error', (error) => {
        res.off('close', abortUpstream);
        if (res.destroyed) {
            return;
        }
        if (isBodiless && !isRetry && !res.headersSent && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
            proxyRequest(req, res, audit, true);
            return;
        }
        audit.upstreamError = error.code ?? error.message;
        if (res.headersSent) {
            res.destroy();
        } else {
            res.writeHead(error.code === 'ETIMEDOUT' ? 504 : 502).end();
        }
    });

    if (isBodiless) {
        upstream.end();
    } else {
        req.pipe(upstream);
    }
}

function proxyUpgrade(req, socket, head) {
    const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.on('error', () => socket.destroy());

    if (req.headers.host !== ownHost || !isOwnOrigin(req) || !isProxied(pathOf(req))) {
        refuse('403 Forbidden');
        return;
    }

    const upstream = transport.request(upstreamOptions(req, upstreamHeaders(req), false));
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        const opened = Date.now();
        let closedBy = '';
        const markClosedBy = (who) => {
            if (!closedBy) {
                closedBy = who;
            }
        };
        log(`ws open status=${upstreamResponse.statusCode}`);
        socket.once('end', () => markClosedBy('client'));
        upstreamSocket.once('end', () => markClosedBy('upstream'));
        socket.once('close', () => {
            markClosedBy('client');
            log(`ws close after_s=${Math.round((Date.now() - opened) / 1000)} by=${closedBy}`);
        });
        const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`];
        for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2) {
            lines.push(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length) {
            socket.write(upstreamHead);
        }
        if (head.length) {
            upstreamSocket.write(head);
        }
        upstreamSocket.on('error', () => {
            markClosedBy('upstream');
            socket.destroy();
        });
        socket.on('close', () => {
            markClosedBy('client');
            upstreamSocket.destroy();
        });
        upstreamSocket.on('close', () => {
            markClosedBy('upstream');
            socket.destroy();
        });
        socket.pipe(upstreamSocket).pipe(socket);
    });
    upstream.on('response', (upstreamResponse) => {
        upstreamResponse.resume();
        log(`ws refused status=${upstreamResponse.statusCode}`);
        refuse(`${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`);
    });
    upstream.on('error', (error) => {
        log(`ws upstream=${logValue(error.code ?? error.message)}`);
        refuse('502 Bad Gateway');
    });
    upstream.end();
}

function serveFile(req, res, file, extraHeaders = {}, onMissing = null) {
    fs.stat(file, (error, stats) => {
        if (error || !stats.isFile()) {
            if (onMissing) {
                onMissing();
            } else {
                res.writeHead(404).end();
            }
            return;
        }
        // Only content-hashed names can be cached for good: a rebuild gives them new names.
        const isHashed = HASHED_ASSET.test(path.basename(file));
        res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': stats.size,
            'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
            ...extraHeaders,
        });
        if (req.method === 'HEAD') {
            res.end();
        } else {
            fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        }
    });
}

function serveStatic(req, res, pathname) {
    let relative;
    try {
        relative = decodeURIComponent(pathname.slice('/static/'.length));
    } catch {
        res.writeHead(400).end();
        return;
    }
    const file = path.resolve(distDir, relative);
    if (!file.startsWith(distDir + path.sep)) {
        res.writeHead(404).end();
        return;
    }
    const reportMissing = () => {
        log(`GET ${logValue(pathname)} status=404`);
        res.writeHead(404).end();
    };
    const isHashed = HASHED_ASSET.test(path.basename(file));
    serveFile(req, res, file, {}, () => {
        // An open tab from before ./build.sh may still ask for a hashed lazy chunk from dist.prev/.
        if (isHashed) {
            const prevFile = path.resolve(prevDistDir, relative);
            if (prevFile.startsWith(prevDistDir + path.sep)) {
                serveFile(req, res, prevFile, {}, reportMissing);
                return;
            }
        }
        reportMissing();
    });
}

function buildSessionCookies(values) {
    return COOKIE_NAMES.map((name) => (
        `${name}=${encodeURIComponent(values[name].trim())}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${name === 'MMAUTHTOKEN' ? '; HttpOnly' : ''}`
    ));
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[ch]));
}

function checkUpstream(callback, isRetry = false) {
    let settled = false;
    const done = (error) => {
        if (!settled) {
            settled = true;
            callback(error);
        }
    };
    const probe = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: 'GET',
        path: '/api/v4/system/ping',
        headers: {host: target.host},
        agent: isRetry ? false : keepAliveAgent,
    });
    probe.setTimeout(pingTimeoutMs, () => probe.destroy(Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})));
    probe.on('response', (upstreamResponse) => {
        upstreamResponse.resume();
        done(upstreamResponse.statusCode >= 500 ? `HTTP_${upstreamResponse.statusCode}` : null);
    });
    probe.on('error', (error) => {
        if (!isRetry && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
            checkUpstream(callback, true);
            return;
        }
        done(error.code ?? error.message);
    });
    probe.end();
}

function renderUpstreamDownPage(reason) {
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Upstream unreachable</title>
<body style="font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:34em;margin:4em auto;padding:0 1em;color:#222">
<h3>Cannot reach ${escapeHtml(target.origin)}</h3>
<p>The server is temporarily unreachable (<code>${escapeHtml(reason)}</code>). Check your VPN or network. This page retries automatically in 5 seconds and keeps your session intact.</p>
<p><button onclick="location.reload()" style="padding:8px 16px;font-size:14px;cursor:pointer">Retry now</button></p>
</body>`;
}

// Check upstream before serving root.html: if the real server is unreachable (e.g. VPN dropped),
// booting the local bundle would fetch /api/v4/config/client -> 502, clear MMUSERID, and land on
// "This server doesn't have any sign-in methods enabled". Returning 502 keeps cookies intact and
// auto-retries until the server is back.
function servePage(req, res) {
    checkUpstream((downReason) => {
        if (res.destroyed) {
            return;
        }
        if (downReason) {
            log(`page upstream=${logValue(downReason)}`);
            res.writeHead(502, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Retry-After': '5',
            });
            res.end(req.method === 'HEAD' ? undefined : renderUpstreamDownPage(downReason));
            return;
        }
        const extraHeaders = {};
        if (activeSession) {
            if (cookieFromHeader(req.headers.cookie, 'MMAUTHTOKEN') !== activeSession.MMAUTHTOKEN) {
                extraHeaders['Set-Cookie'] = buildSessionCookies(activeSession);
            }
        }
        serveFile(req, res, path.join(distDir, 'root.html'), extraHeaders);
    });
}

function readBody(req, onBody, res) {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) {
            chunks.push(chunk);
        }
    });
    req.on('end', () => {
        if (size > MAX_BODY_BYTES) {
            res.writeHead(413).end();
        } else {
            onBody(Buffer.concat(chunks).toString('utf8'));
        }
    });
}

// The ALL pseudo-team's categories and channel order, so they survive a wiped browser profile.
function serveLayout(req, res) {
    if (req.method === 'GET') {
        fs.readFile(layoutFile, 'utf8', (error, content) => {
            if (error) {
                res.writeHead(error.code === 'ENOENT' ? 204 : 500).end();
            } else {
                res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-cache'}).end(content);
            }
        });
        return;
    }
    if (req.method !== 'PUT') {
        res.writeHead(405).end();
        return;
    }
    if (!isOwnOrigin(req) || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        res.writeHead(403).end();
        return;
    }
    readBody(req, (body) => {
        let layout;
        try {
            layout = JSON.parse(body);
        } catch {
            layout = null;
        }
        if (!Array.isArray(layout?.groups) || !layout.groups.some((group) => group.id === 'default')) {
            res.writeHead(400).end();
            return;
        }

        // Written to the side and renamed, so a crash can't leave half a file.
        const tmpFile = `${layoutFile}.${process.pid}.${tmpCounter++}.tmp`;
        fs.writeFile(tmpFile, JSON.stringify(layout, null, 2), (writeError) => {
            if (writeError) {
                res.writeHead(500).end();
                return;
            }
            fs.rename(tmpFile, layoutFile, (renameError) => {
                res.writeHead(renameError ? 500 : 204).end();
            });
        });
    }, res);
}

// What only the page knows, such as a send that never reached this proxy.
function serveClientLog(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    if (!isOwnOrigin(req) || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        res.writeHead(403).end();
        return;
    }
    readBody(req, (body) => {
        let report;
        try {
            report = JSON.parse(body);
        } catch {
            res.writeHead(400).end();
            return;
        }
        const fields = CLIENT_LOG_FIELDS.filter((name) => report?.[name] !== undefined && report[name] !== '').map((name) => `${name}=${logValue(report[name])}`);
        log(`client ${fields.join(' ')}`);
        res.writeHead(204).end();
    }, res);
}

function extractDesktopServerToken(raw) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.includes('server_token=')) {
        try {
            const parsed = new URL(trimmed);
            const token = parsed.searchParams.get('server_token');
            if (token) {
                return token.trim();
            }
        } catch {
            // Fall through to query-string parsing for non-standard or partial URLs.
        }
        const queryStart = trimmed.indexOf('?');
        const params = new URLSearchParams(queryStart >= 0 ? trimmed.slice(queryStart + 1) : trimmed);
        return (params.get('server_token') ?? '').trim();
    }
    if (/[\s/?#]/.test(trimmed)) {
        return '';
    }
    return trimmed;
}

function renderAuthForm(prefillUrl = '', errorMessage = '') {
    const bookmarklet = `javascript:void(location.href=${JSON.stringify(`${ownOrigin}/__auth?url=`)}+encodeURIComponent(location.href))`;
    const providerButtons = ssoProviders.length > 0
        ? ssoProviders.map((provider, index) => (
            `  <button type="button" onclick="openSso(${escapeHtml(JSON.stringify(provider.path))})" style="padding:8px 16px;font-size:14px;cursor:pointer${index > 0 ? ';margin-left:8px' : ''}">${escapeHtml(provider.label)}</button>`
        )).join('\n')
        : `  <label style="display:block;margin-bottom:8px">SSO path on ${escapeHtml(target.host)}:
    <input id="sso-path-input" list="sso-paths" value="/oauth/gitlab/login" style="width:100%;max-width:22em;padding:6px 8px;margin-top:4px;box-sizing:border-box">
    <datalist id="sso-paths">
      <option value="/oauth/gitlab/login">GitLab</option>
      <option value="/oauth/google/login">Google</option>
      <option value="/oauth/office365/login">Office 365 / Entra ID</option>
      <option value="/oauth/openid/login">OpenID Connect</option>
      <option value="/login/sso/saml">SAML</option>
    </datalist>
  </label>
  <button type="button" onclick="openSso(document.getElementById('sso-path-input').value.trim())" style="padding:8px 16px;font-size:14px;cursor:pointer">1. Open SSO on ${escapeHtml(target.host)}</button>`;
    return `<!doctype html><meta charset="utf-8"><title>Matterless proxy sign-in</title>
<body style="font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:42em;margin:3em auto;padding:0 1em;color:#222">
<h3>Sign in via SSO (${escapeHtml(target.origin)})</h3>
<p>Creates an independent session for the local proxy. You do not need to keep a second server configured in Mattermost Desktop.</p>
${errorMessage ? `<p style="padding:10px 12px;background:#fdecea;border:1px solid #f5c2c0;border-radius:6px;color:#8a1c17">${escapeHtml(errorMessage)}</p>` : ''}
<p>
${providerButtons}
</p>
<form method="post" action="/__auth/desktop" style="margin-top:16px">
  <label>2. After signing in in your browser, paste the final redirect URL (with <code>server_token=...</code>) or the raw token:<br>
  <input id="desktop-token-input" name="token" value="${escapeHtml(prefillUrl)}" placeholder="${escapeHtml(target.origin)}/login/desktop?server_token=..." style="width:100%;padding:8px;margin-top:6px;box-sizing:border-box" autocomplete="off"></label><br><br>
  <button style="padding:8px 16px;font-size:14px;cursor:pointer">Sign in and save session</button>
</form>
<p style="margin-top:20px;font-size:13px;color:#555">
  For one-click handoff, drag this to your bookmarks bar:
  <a href="${escapeHtml(bookmarklet)}" style="display:inline-block;padding:2px 8px;border:1px solid #bbb;border-radius:4px;text-decoration:none;color:#222;background:#f5f5f5">Send token to Matterless</a>
  On <code>${escapeHtml(target.host)}/login/desktop?...</code>, clicking the bookmark opens this form pre-filled.
</p>
<details style="margin-top:24px">
  <summary style="cursor:pointer;color:#555">Fallback: paste cookies manually from DevTools</summary>
  <p>Open ${escapeHtml(target.origin)} &rarr; DevTools &rarr; Application &rarr; Cookies &rarr; copy these three values:</p>
  <form method="post" action="/__auth">
${COOKIE_NAMES.map((name) => `  <label>${name}<br><input name="${name}" style="width:100%;box-sizing:border-box" autocomplete="off"></label><br><br>`).join('\n')}
  <button>Set cookies and open app</button>
  </form>
</details>
<script>
function openSso(oauthPath) {
  if (!oauthPath || !oauthPath.startsWith('/') || oauthPath.startsWith('//')) {
    return;
  }
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  var token = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  window.open(${JSON.stringify(target.origin)} + oauthPath + '?desktop_token=' + token, '_blank', 'noopener');
}
</script>
</body>`;
}

function serveAuth(req, res) {
    if (req.method === 'GET') {
        const queryStart = req.url.indexOf('?');
        const prefill = queryStart >= 0 ? (new URLSearchParams(req.url.slice(queryStart + 1)).get('url') ?? '') : '';
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'}).end(renderAuthForm(prefill));
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    if (!isOwnOrigin(req)) {
        res.writeHead(403).end();
        return;
    }
    readBody(req, (body) => {
        const fields = new URLSearchParams(body);
        const values = Object.fromEntries(COOKIE_NAMES.map((name) => [name, fields.get(name) ?? '']));
        if (!COOKIE_NAMES.every((name) => values[name])) {
            res.writeHead(400, {'Content-Type': 'text/plain'}).end('all three cookies are required');
            return;
        }
        saveSession(values);
        res.writeHead(302, {'Set-Cookie': buildSessionCookies(values), Location: '/'}).end();
    }, res);
}

function serveAuthDesktop(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    if (!isOwnOrigin(req)) {
        res.writeHead(403).end();
        return;
    }
    readBody(req, (body) => {
        let raw = '';
        if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
            try {
                const parsed = JSON.parse(body);
                raw = parsed?.token ?? parsed?.url ?? '';
            } catch {
                raw = '';
            }
        } else {
            const fields = new URLSearchParams(body);
            raw = fields.get('token') ?? fields.get('url') ?? '';
        }
        const serverToken = extractDesktopServerToken(raw);
        if (!serverToken) {
            res.writeHead(400, {'Content-Type': 'text/html; charset=utf-8'}).end(renderAuthForm(raw, 'No server_token found. Paste the /login/desktop?server_token=... URL or the raw token.'));
            return;
        }

        const payload = Buffer.from(JSON.stringify({token: serverToken, deviceId: ''}));
        const upstream = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            method: 'POST',
            path: '/api/v4/users/login/desktop_token',
            headers: {
                host: target.host,
                origin: target.origin,
                'content-type': 'application/json',
                'content-length': payload.length,
            },
            agent: false,
        });
        upstream.setTimeout(postTimeoutMs, () => upstream.destroy(Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})));
        upstream.on('response', (upstreamResponse) => {
            const chunks = [];
            upstreamResponse.on('data', (chunk) => chunks.push(chunk));
            upstreamResponse.on('end', () => {
                if (res.destroyed) {
                    return;
                }
                const cookies = upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300
                    ? cookiesFromSetCookie(upstreamResponse.headers['set-cookie'])
                    : null;
                if (cookies) {
                    saveSession(cookies);
                    res.writeHead(302, {'Set-Cookie': buildSessionCookies(cookies), Location: '/'}).end();
                    return;
                }
                const errorId = errorIdOf(Buffer.concat(chunks), upstreamResponse.headers['content-encoding']);
                log(`auth desktop status=${upstreamResponse.statusCode}${errorId ? ` err=${logValue(errorId)}` : ''}`);
                const status = upstreamResponse.statusCode >= 400 ? upstreamResponse.statusCode : 502;
                res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8'}).end(
                    renderAuthForm('', `Server rejected the token (HTTP ${upstreamResponse.statusCode}). It may already be used or expired; open SSO again.`),
                );
            });
        });
        upstream.on('error', (error) => {
            if (res.destroyed) {
                return;
            }
            const code = error.code ?? error.message;
            log(`auth desktop upstream=${logValue(code)}`);
            res.writeHead(code === 'ETIMEDOUT' ? 504 : 502, {'Content-Type': 'text/html; charset=utf-8'}).end(
                renderAuthForm(raw, `Could not reach ${target.origin} (${code}).`),
            );
        });
        upstream.end(payload);
    }, res);
}

const server = http.createServer((req, res) => {
    // A site whose hostname is rebound to 127.0.0.1 would otherwise get the session cookies and the
    // proxy to the real server.
    if (req.headers.host !== ownHost) {
        res.writeHead(403).end();
        return;
    }

    const pathname = pathOf(req);
    if (pathname === '/__auth') {
        serveAuth(req, res);
    } else if (pathname === '/__auth/desktop') {
        serveAuthDesktop(req, res);
    } else if (pathname === '/__all_teams_layout' && layoutFile) {
        serveLayout(req, res);
    } else if (pathname === '/__client_log') {
        serveClientLog(req, res);
    } else if (isProxied(pathname)) {
        proxyRequest(req, res);
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
    } else if (pathname.startsWith('/static/')) {
        serveStatic(req, res, pathname);
    } else if ((req.headers.accept ?? '').includes('text/html') && !path.basename(pathname).includes('.')) {
        servePage(req, res);
    } else {
        res.writeHead(404).end();
    }
});

server.on('upgrade', proxyUpgrade);

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`port ${port} is busy: is the previous server still running?`);
    } else {
        console.error(error.message);
    }
    process.exit(1);
});

// Loopback only: this process holds a live session to the real server.
server.listen(port, 'localhost', () => {
    let build = 'unknown build';
    try {
        build = fs.readFileSync(path.join(distDir, 'BUILD'), 'utf8').trim();
    } catch {
        // Built by hand.
    }
    console.log(`${ownOrigin} -> ${target.origin} (${build})`);
});
