// Proof for the two CLIENTS of the public JSON API - the MCP server and the CLI.
//
// Both are driven against a LOCAL STUB of api.php, never the live host: a test that needs
// production to pass is a test that goes red when somebody else's network hiccups, and it
// cannot exercise a 400 or an oversized attachment on demand. The live host is proved
// separately, by an actual request whose response is pasted into the record.
//
// The stub RECORDS every request it is given, so these tests assert the URL and the query
// the client actually put on the wire - not just that the client parsed a reply it was
// handed. A client that silently dropped ?topic= would pass a reply-only test.

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {spawn} = require('node:child_process');

const DIR = __dirname;
const CLIENT = path.join(DIR, 'archive-client.js');
const MCP = path.join(DIR, 'aim-lt-archive-mcp.js');
const CLI = path.join(DIR, 'aim-lt.js');

for (const file of [CLIENT, MCP, CLI]) {
  if (!require('node:fs').existsSync(file)) {
    process.stderr.write(`RED: ${path.basename(file)} is missing\n`);
    process.exit(1);
  }
}

const {createArchiveClient, ArchiveApiError} = require(CLIENT);

let passed = 0;
function check(condition, name) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
}

function message(id, over = {}) {
  return {
    source: 'group', message_id: id, source_date: `2026-09-0${1 + (id % 5)}T08:00:00Z`,
    edit_date: null, text: `zinute ${id} apie n8n`, author_marker: 'abcd', reply_to_id: null,
    topics: ['n8n'], media: null,
    url: `https://grupe.aimastermind.lt/archive/?source=group&message=${id}`,
    telegram_url: `https://t.me/c/3763547735/${id}`, ...over,
  };
}

/** A stand-in for api.php: records requests, answers the shapes api.php really answers. */
function startStub() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    seen.push({method: request.method, path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      userAgent: request.headers['user-agent'] || ''});
    const json = (status, payload) => {
      response.writeHead(status, {'Content-Type': 'application/json; charset=UTF-8'});
      response.end(JSON.stringify(payload));
    };
    const envelope = (surface) => ({api_version: 1, surface, generated_at: '2026-09-07T09:00:00Z',
      valid_until: '2026-09-08T02:00:00Z', coverage: 'partial; deletion reconciliation incomplete'});
    if (url.pathname === '/bendra/api.php/v1/' || url.pathname === '/bendra/api.php') {
      return json(200, {api_version: 1, name: 'AI Mastermind LT community archive',
        resources: {messages: {}, message: {}, search: {}, media: {}},
        limits: {size_max: 100, page_max: 200, media_max_bytes: 1048576}});
    }
    if (url.pathname === '/bendra/api.php/v1/messages' || url.pathname === '/bendra/api.php/v1/search') {
      const surface = url.pathname.endsWith('search') ? 'search' : 'list';
      if (surface === 'search' && !url.searchParams.get('q')) {
        return json(400, {api_version: 1, error: 'query_required', message: 'The request was refused: query_required.'});
      }
      const size = Number(url.searchParams.get('size') || 50);
      return json(200, {...envelope(surface), page: {page: 1, size, size_capped: false, has_more: true},
        count: Math.min(size, 3), messages: [message(901), message(902), message(903)].slice(0, size)});
    }
    if (url.pathname === '/bendra/api.php/v1/message') {
      if (url.searchParams.get('message') === '404404') {
        return json(404, {api_version: 1, error: 'message_not_found', message: 'No such published message.'});
      }
      return json(200, {...envelope('detail'), message: message(Number(url.searchParams.get('message')))});
    }
    // The two SHELVES, the only surfaces that carry a machine-written `description` object.
    // One row with full provenance and one whose effort was never recorded, so the render
    // path is proved in BOTH directions - a renderer that only ever sees a populated field
    // cannot show whether it invents a value when the field is empty.
    if (url.pathname === '/bendra/api.php/v1/links') {
      return json(200, {...envelope('list'), page: {page: 1, size: 50, has_more: false}, count: 2,
        links: [
          {source: 'group', message_id: 901, url: 'https://example.com/a', context: 'ziurek',
           source_date: '2026-09-01T08:00:00Z', message_url: 'https://grupe.aimastermind.lt/bendra/?message=901',
           description: {text: 'Puslapis apie n8n.', generated_by: 'model', model: 'qwen2.5vl:7b',
             effort: 'single-pass', effort_scale: 'decode',
             effort_params: 'num_predict=220;temperature=0.1',
             prompt_version: 'aim-lt-describe-1', language: 'lt'}},
          {source: 'group', message_id: 902, url: 'https://example.com/b', context: 'kita',
           source_date: '2026-09-02T08:00:00Z', message_url: 'https://grupe.aimastermind.lt/bendra/?message=902',
           description: {text: 'Senas aprasymas.', generated_by: 'model', model: 'qwen2.5vl:7b',
             effort: null, effort_scale: null, effort_params: null, language: 'lt'}},
        ]});
    }
    if (url.pathname === '/bendra/api.php/v1/media') {
      if (url.searchParams.get('media') === 'b'.repeat(64)) {
        return json(404, {api_version: 1, error: 'media_too_large', message: 'Attachment exceeds the cap.'});
      }
      if (url.searchParams.get('media') === 'c'.repeat(64)) {
        // A server that ignored its own cap. The CLIENT must still refuse to buffer it.
        response.writeHead(200, {'Content-Type': 'image/png'});
        return response.end(Buffer.alloc(3 * 1024 * 1024, 7));
      }
      response.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': '72'});
      return response.end(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]));
    }
    if (url.pathname === '/apzvalgos/index.json') {
      return json(200, {schema_version: 1, editions: [
        {date: '2026-09-06', window_end_utc: '20260906T020000Z', url: '/editions.html#e-20260906',
         message_count: 41, topics: [{id: 'n8n', label: 'n8n', count: 7}]}]});
    }
    if (url.pathname === '/apzvalgos/edition-20260906T020000Z.json') {
      return json(200, {date: '2026-09-06', topics: [{id: 'n8n', label: 'n8n', count: 7, source_message_ids: [901]}]});
    }
    return json(404, {api_version: 1, error: 'unknown_resource', message: 'no'});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({server, seen, base: `http://127.0.0.1:${server.address().port}`});
  }));
}

function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], {env: {...process.env, ...env}, timeout: 20000},
      (error, stdout, stderr) => resolve({code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0), stdout, stderr}));
  });
}

/** One MCP conversation over stdio: write every request, collect every line of reply. */
function mcpSession(requests, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP], {env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', () => resolve({
      messages: out.split('\n').filter(Boolean).map((line) => JSON.parse(line)), stderr: err,
    }));
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 15000).unref();
  });
}

(async () => {
  const {server, seen, base} = await startStub();
  const env = {AIM_LT_ARCHIVE_BASE_URL: base};
  try {
    // ------------------------------------------------------------------ the shared client
    const client = createArchiveClient({baseUrl: base});
    const index = await client.index();
    check(index.api_version === 1, 'client reads the API index');
    check(seen.at(-1).path === '/bendra/api.php/v1/', 'the index address is the versioned root');
    check(/aim-lt-archive-client/.test(seen.at(-1).userAgent), 'the client identifies itself honestly');

    const list = await client.messages({source: 'group', topic: 'n8n', size: 2});
    check(list.surface === 'list', 'messages() reaches the list surface');
    check(seen.at(-1).path === '/bendra/api.php/v1/messages', 'messages() uses the messages resource');
    check(seen.at(-1).query.topic === 'n8n' && seen.at(-1).query.source === 'group',
      'every filter the caller gave reaches the wire');
    check(seen.at(-1).query.size === '2', 'size reaches the wire');

    await client.messages({source: 'group', topic: undefined, from: null, q: ''});
    check(!('topic' in seen.at(-1).query) && !('from' in seen.at(-1).query) && !('q' in seen.at(-1).query),
      'empty and absent values are dropped, never sent as blanks the server must refuse');

    const search = await client.search({q: 'n8n'});
    check(search.surface === 'search' && seen.at(-1).query.q === 'n8n', 'search() passes q');
    const one = await client.message({source: 'group', message: 901});
    check(one.message.message_id === 901, 'message() returns one message');

    // The error contract: a refusal must arrive as a typed error carrying the machine code,
    // never as a resolved promise the caller has to inspect for an `error` key.
    let caught = null;
    try { await client.search({q: '' }); } catch (error) { caught = error; }
    check(caught instanceof ArchiveApiError, 'a refusal throws ArchiveApiError');
    check(caught.status === 400 && caught.code === 'query_required', 'the error carries status and code');
    caught = null;
    try { await client.message({source: 'group', message: 404404}); } catch (error) { caught = error; }
    check(caught && caught.status === 404 && caught.code === 'message_not_found', 'a 404 throws with its code');

    const media = await client.media('a'.repeat(64));
    check(media.contentType === 'image/png' && media.bytes === 72, 'media() returns type and length');
    check(Buffer.isBuffer(media.body) && media.body.length === 72, 'media() returns the bytes');
    caught = null;
    try { await client.media('b'.repeat(64)); } catch (error) { caught = error; }
    check(caught && caught.code === 'media_too_large', 'the server cap surfaces as a typed error');
    // CLIENT-SIDE cap. The server caps at 1 MiB, but a client that trusts a server to bound
    // its own response has no bound at all - this one refuses before it buffers.
    caught = null;
    try { await client.media('c'.repeat(64)); } catch (error) { caught = error; }
    check(caught && caught.code === 'media_too_large', 'the client refuses an oversized body even if the server sends one');

    const digests = await client.digestIndex();
    check(digests.editions[0].date === '2026-09-06', 'digestIndex() reads the published digest list');
    const digest = await client.digest('20260906T020000Z');
    check(digest.topics[0].source_message_ids[0] === 901, 'digest() reads one edition');

    // ------------------------------------------------------------------ the MCP server
    const session = await mcpSession([
      {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}}},
      {jsonrpc: '2.0', method: 'notifications/initialized'},
      {jsonrpc: '2.0', id: 2, method: 'tools/list'},
      {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'archive_search', arguments: {q: 'n8n', size: 2}}},
      {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'archive_message', arguments: {source: 'group', message_id: 404404}}},
      {jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'archive_media', arguments: {media_id: 'a'.repeat(64)}}},
      {jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'archive_export', arguments: {}}},
      {jsonrpc: '2.0', id: 7, method: 'resources/list'},
      {jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'archive_links', arguments: {}}},
    ], env);
    const reply = (id) => session.messages.find((m) => m.id === id);
    check(reply(1).result.serverInfo.name === 'aim-lt-archive', 'initialize names the server');
    check(reply(1).result.protocolVersion === '2025-06-18', 'initialize echoes a protocol version it supports');
    check(reply(1).result.capabilities.tools !== undefined, 'the server advertises tools');
    check(!session.messages.some((m) => m.id === undefined && m.error), 'a notification draws no reply');

    const tools = reply(2).result.tools.map((tool) => tool.name);
    check(JSON.stringify(tools) === JSON.stringify(['archive_search', 'archive_list', 'archive_message',
      'archive_media', 'archive_links', 'archive_files']),
      'exactly six tools over the four GRANTED surfaces');
    // The shelves must ANNOUNCE that their descriptions are machine-written. An assistant that
    // reads only the tool description is the one most likely to quote a sentence as a member's.
    const shelfText = JSON.stringify(reply(2).result.tools.filter(
      (tool) => tool.name === 'archive_links' || tool.name === 'archive_files'));
    check(/MACHINE-WRITTEN/.test(shelfText), 'both shelves declare their descriptions machine-written');
    check(/never fetches a shared address/i.test(shelfText),
      'archive_links states that no shared URL is ever fetched');
    check(/DESCRIPTIONS ARE MACHINE-WRITTEN/.test(JSON.stringify(reply(1).result.instructions)),
      'the server instructions repeat it, so a client that reads only those still knows');

    // MODEL x EFFORT in the TEXT rendering (CEO 2026-09-07, EU AI Act transparency). The text
    // block is what an assistant quotes; provenance that lives only in the JSON beside it is
    // provenance the quoting path never sees.
    const shelf = reply(8).result.content[0].text;
    check(/AI aprasymas \(qwen2\.5vl:7b, decode\/single-pass; num_predict=220;temperature=0\.1\)/.test(shelf),
      'the shelf line names the model AND the effort, with the scale that disambiguates it');
    check(/AI aprasymas \(qwen2\.5vl:7b, effort not recorded\)/.test(shelf),
      'a row with no recorded effort SAYS so rather than borrowing a plausible value');
    check(/model and the generation effort/.test(shelf),
      'the shelf header tells a reader what the parenthesis is');
    const searchTool = reply(2).result.tools[0];
    check(searchTool.inputSchema.required.includes('q'), 'archive_search requires q');
    check(searchTool.inputSchema.properties.size.maximum === 100, 'the tool schema states the real ceiling');
    check(!/export|dump|all/i.test(JSON.stringify(tools)), 'no tool offers a bulk export');

    const searched = reply(3).result;
    check(searched.isError !== true, 'a good search is not an error');
    check(searched.structuredContent.messages.length === 2, 'the tool returns structured messages');
    check(searched.content[0].type === 'text' && /901/.test(searched.content[0].text),
      'and a text rendering an assistant can read directly');
    check(/no endpoint returns the whole archive/i.test(JSON.stringify(searched)) === false,
      'the tool result is data, not a lecture - the notice lives in the index, not every reply');

    const missing = reply(4);
    check(missing.error === undefined, 'a MISSING MESSAGE is not a protocol error');
    check(missing.result.isError === true, 'it is a tool error');
    check(/message_not_found/.test(missing.result.content[0].text), 'and it names the reason');
    const image = reply(5).result;
    check(image.content[0].type === 'image' && image.content[0].mimeType === 'image/png',
      'an approved raster comes back as an MCP image block the assistant can actually see');
    check(reply(6).result.isError === true, 'an unknown tool is refused');
    check(reply(7).error.code === -32601, 'an unimplemented method is a proper JSON-RPC error');

    // ------------------------------------------------------------------ the CLI
    const help = await run(CLI, [], env);
    check(help.code === 2 && /search/.test(help.stdout + help.stderr), 'no arguments prints usage and fails');
    const human = await run(CLI, ['search', 'n8n'], env);
    check(human.code === 0, 'search exits 0');
    check(/#901/.test(human.stdout), 'human output carries the message id');
    check(/2026-09-0/.test(human.stdout), 'human output carries the date');
    check(/grupe\.aimastermind\.lt\/archive\/\?source=group&message=901/.test(human.stdout), 'and the openable URL');
    check(!/\{"api_version"/.test(human.stdout), 'human output is not raw JSON');

    const asJson = await run(CLI, ['search', 'n8n', '--json'], env);
    check(asJson.code === 0 && JSON.parse(asJson.stdout).surface === 'search', '--json prints the raw envelope');
    const read = await run(CLI, ['read', '901', '--source', 'group'], env);
    check(read.code === 0 && /#901/.test(read.stdout), 'read prints one message');
    const day = await run(CLI, ['day', '2026-09-05'], env);
    check(day.code === 0, 'day exits 0');
    check(seen.at(-1).query.from === '2026-09-05' && seen.at(-1).query.to === '2026-09-05',
      'day asks the server for that calendar day, using the reader own from/to contract');
    const dg = await run(CLI, ['digest', '--json'], env);
    check(dg.code === 0 && JSON.parse(dg.stdout).editions[0].date === '2026-09-06', 'digest reads the published index');
    const bad = await run(CLI, ['read', '404404', '--source', 'group'], env);
    check(bad.code === 1, 'a refused request exits non-zero');
    check(/message_not_found/.test(bad.stderr), 'and says why on stderr');
    const badFlag = await run(CLI, ['search', 'n8n', '--nope', '1'], env);
    check(badFlag.code === 2, 'an unknown CLI flag is refused rather than silently ignored');

    process.stdout.write(`Tests: ${passed} passed; 0 failed\n`);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error) + '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
