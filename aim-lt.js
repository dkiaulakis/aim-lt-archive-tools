#!/usr/bin/env node
'use strict';

/**
 * aim-lt - read the AI Mastermind LT public community archive from a terminal.
 *
 * A thin, honest client of the public JSON API: no database, no credential, nothing a visitor
 * with a browser could not also see. Human-readable by default, `--json` for a machine.
 *
 * ONE REQUEST PER INVOCATION, deliberately. There is no --all and no auto-paging loop: the
 * archive publishes only the four granted surfaces and no bulk export, and a client that
 * walked every page in a loop would be a bulk export with extra steps. `--page` is how you
 * ask for more, one page at a time - which is also what the site asks a machine to do.
 */

const {createArchiveClient, ArchiveApiError} = require('./archive-client');

const USAGE = `aim-lt - AI Mastermind LT public community archive

  aim-lt search <words...>        find messages by full text
  aim-lt list                     browse newest first
  aim-lt read <id> --source <s>   read one message
  aim-lt day <YYYY-MM-DD>         everything published on one calendar day (Europe/Vilnius)
  aim-lt digest [<window-end>]    the daily digest index, or one digest
  aim-lt info                     what the API offers, and its limits

Options
  --source group|channel   which published chat
  --topic <id>             one of the sixteen approved categories
  --from / --to <date>     YYYY-MM-DD, Europe/Vilnius calendar days
  --page <n>               1..200          --size <n>   1..100 (default 50)
  --json                   print the raw API envelope instead of the human rendering

Environment
  AIM_LT_ARCHIVE_BASE_URL  override the host (default https://grupe.aimastermind.lt)

The archive is an approved, redacted, pseudonymous subset. It never says who wrote a message.
Coverage is partial and deletion reconciliation is incomplete. There is no whole-archive dump.`;

const FLAGS = ['source', 'topic', 'from', 'to', 'page', 'size'];
const BOOLEANS = ['json', 'help'];

/** Parse argv strictly. An unknown flag is an ERROR: silently ignoring `--soruce group` would
 *  hand back the whole archive and look like a correct answer to a narrowed question. */
function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const name = token.slice(2);
    if (BOOLEANS.includes(name)) { options[name] = true; continue; }
    if (!FLAGS.includes(name)) throw new UsageError(`unknown option: ${token}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`option ${token} needs a value`);
    options[name] = value;
  }
  return {positional, options};
}

class UsageError extends Error {}

function filters(options) {
  return {source: options.source, topic: options.topic, from: options.from, to: options.to,
    page: options.page, size: options.size};
}

function renderMessage(message) {
  const date = (message.source_date || 'date unknown').replace('T', ' ').replace('Z', ' UTC');
  const topics = (message.topics || []).join(', ');
  const marker = message.author_marker ? ` ~${message.author_marker}` : '';
  const media = message.media ? `\n  attachment: ${message.media.media_type || 'file'} ${message.media.media_id}` : '';
  const body = String(message.text || '').split('\n').map((line) => '  ' + line).join('\n');
  return `#${message.message_id} [${message.source}${marker}] ${date}${topics ? '  {' + topics + '}' : ''}\n`
    + `${body}${media}\n  ${message.url}`;
}

function renderList(payload) {
  const page = payload.page || {};
  const head = `${payload.count} message(s) - page ${page.page}, ${page.size} per page`
    + (page.size_capped ? ' (size was capped to the API maximum)' : '')
    + (page.has_more ? `\nmore available: --page ${page.page + 1}` : '');
  const body = (payload.messages || []).map(renderMessage).join('\n\n');
  return `${head}\n\n${body}\n\nsnapshot valid until ${payload.valid_until}; coverage: ${payload.coverage}`;
}

function renderDigestIndex(payload) {
  return (payload.editions || []).map((edition) => {
    const topics = (edition.topics || []).map((topic) => `${topic.label}:${topic.count}`).join(', ');
    return `${edition.date}  ${edition.message_count} message(s)  [${edition.window_end_utc}]\n  ${topics}`;
  }).join('\n') || '(no digests published)';
}

async function main(argv) {
  const {positional, options} = parseArgs(argv);
  if (options.help || positional.length === 0) throw new UsageError('');
  const client = createArchiveClient({});
  const [command, ...rest] = positional;
  const json = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };

  if (command === 'info') {
    const payload = await client.index();
    if (options.json) return json(payload);
    const lines = Object.entries(payload.resources).map(([name, resource]) =>
      `  ${name.padEnd(9)} ${resource.surface.padEnd(7)} ${resource.url}\n    ${resource.description}`);
    // THE TOPIC KEYS, printed. The API has always returned them and this command never showed
    // them, so the only way to learn a valid ?topic= value was to read the raw JSON - and a
    // guessed topic returns nothing, which reads exactly like an empty archive. The KEY is what
    // ?topic= takes; the label beside it is the human name and is often Lithuanian.
    const topics = Object.entries(payload.topics || {});
    const topicBlock = topics.length
      ? '\n\ntopics (use the key with --topic):\n'
        + topics.map(([key, label]) => `  ${key.padEnd(18)} ${label}`).join('\n')
      : '';
    return process.stdout.write(`${payload.name}\n\n${lines.join('\n')}${topicBlock}\n\nlimits: `
      + `${JSON.stringify(payload.limits)}\n\n${payload.notice}\n`);
  }
  if (command === 'search') {
    if (!rest.length) throw new UsageError('search needs words to look for');
    const payload = await client.search({q: rest.join(' '), ...filters(options)});
    return options.json ? json(payload) : process.stdout.write(renderList(payload) + '\n');
  }
  if (command === 'list') {
    const payload = await client.messages(filters(options));
    return options.json ? json(payload) : process.stdout.write(renderList(payload) + '\n');
  }
  if (command === 'read') {
    if (!rest.length) throw new UsageError('read needs a message id');
    // `from`/`to` mean nothing for one message, so they are not forwarded: the API would
    // refuse them as unknown parameters on the detail surface.
    const payload = await client.message({source: options.source || 'group', message: rest[0]});
    return options.json ? json(payload) : process.stdout.write(renderMessage(payload.message) + '\n');
  }
  if (command === 'day') {
    if (!rest.length) throw new UsageError('day needs a date, YYYY-MM-DD');
    // from and to are INCLUSIVE calendar days in the reader's own contract (it advances `to`
    // by one day internally), so one day is from == to. Re-deriving that here would be a
    // second date rule that could disagree with the page.
    const payload = await client.messages({...filters(options), from: rest[0], to: rest[0]});
    return options.json ? json(payload) : process.stdout.write(renderList(payload) + '\n');
  }
  if (command === 'digest') {
    if (rest.length) {
      const payload = await client.digest(rest[0]);
      return options.json ? json(payload) : process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    }
    const payload = await client.digestIndex();
    return options.json ? json(payload) : process.stdout.write(renderDigestIndex(payload) + '\n');
  }
  throw new UsageError(`unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) {
    if (error.message) process.stderr.write(`aim-lt: ${error.message}\n\n`);
    process.stdout.write(USAGE + '\n');
    process.exit(2);
  }
  if (error instanceof ArchiveApiError) {
    process.stderr.write(`aim-lt: ${error.code}: ${error.detail}\n  ${error.url}\n`);
    process.exit(1);
  }
  process.stderr.write(`aim-lt: ${String(error && error.message || error)}\n`);
  process.exit(1);
});
