// Is an email address a real, lasting inbox?
//
// Confirming the address with a code stops invented addresses, but not
// throwaway ones: a temp-mail inbox really does receive the code. Those are
// caught here, in two layers:
//
//   1. A public list of disposable domains (~10,000), bundled as a snapshot and
//      refreshed from its source once a day.
//   2. The domain's mail servers. Temp-mail services rotate their domains daily
//      but keep the same servers, so a domain no list has heard of yet is still
//      recognised by where it receives mail. preparmy.com is on no list at all,
//      but its mail goes to mail.wabblywabble.com, which in a survey of the
//      public list served 54 other throwaway domains.

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const axios = require('axios');

const LIST_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
const BUNDLED_LIST = path.join(__dirname, '..', 'data', 'disposable-domains.txt');
const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
const MX_TIMEOUT_MS = 4000;
const MX_CACHE_MS = 60 * 60 * 1000;

// Throwaway domains seen in our own signups or missing from the public list.
const EXTRA_DOMAINS = [
  'preparmy.com',
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'sharklasers.com', 'grr.la', 'spam4.me', '10minutemail.com', '10minutemail.net',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'fakeinbox.com',
  'trashmail.com', 'trashmail.de', 'trash-mail.com', 'mytrashmail.com', 'dispostable.com',
  'getnada.com', 'nada.email', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com',
  'tempinbox.com', 'emailondeck.com', 'moakt.com', 'mohmal.com', 'luxusmail.org',
  'inboxkitten.com', 'mailpoof.com', 'tempmailaddress.com', 'burnermail.io',
  'mail-temp.com', 'minuteinbox.com', 'mail7.io', 'tmpmail.org', 'tmpmail.net',
  'tmails.net', 'crazymailing.com', 'emltmp.com', 'mailtemp.top', 'tempail.com',
  'byom.de', 'spambox.us', 'spambog.com', 'spamgourmet.com', 'incognitomail.com',
  'mailexpire.com', 'jetable.org', 'meltmail.com', 'nowmymail.com', 'armyspy.com',
  'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com',
  'rhyta.com', 'superrito.com', 'teleworm.us', 'wegwerfmail.de', 'discard.email',
  'linshiyouxiang.net', 'tempmail.plus', 'vmani.com', 'dropmail.me', 'firemailbox.club'
];

// Mail servers that serve nothing but throwaway domains. Found by resolving the
// MX records of 1,500 domains from the public list and keeping the servers that
// handled three or more of them. Matched as the host itself or any subdomain.
//
// Shared infrastructure that also serves ordinary businesses turned up in the
// same survey and is deliberately left out: Cloudflare Email Routing
// (mx.cloudflare.net), Google Workspace (google.com, googlemail.com), Mailgun,
// Namecheap forwarding and Private Email, parking hosts, generic ISPs.
const DISPOSABLE_MX = [
  'chatgpt.org.uk', 'generator.email', 'wabblywabble.com', 'wallywatts.com',
  'tinyhost.shop', 'gravityengine.cc', 'emailfake.com', 'email-fake.com',
  'casadorock.com', 'vietxf.com', 'erinn.biz', 'tempmail.tw', 'oneb.net',
  'mail.tm', 'beavis99.com', 'beavis99.net', 'mailinator.com', 'catchservers.com',
  'catchservers.net', 'yopmail.com', 'tempm.com', 'brushemail.com', 'rejecthost.com',
  'papierkorb.me', 'spam4.me', 'mainnetmail.com', 'darkvilto.biz', 'balansor.com',
  'patternemail.com', 'moakt.com'
];

let disposableDomains = new Set();

function readList(text) {
  return String(text)
    .split(/\r?\n/)
    .map(line => line.trim().toLowerCase())
    .filter(line => line && !line.startsWith('#'));
}

function loadBundledList() {
  let bundled = [];
  try {
    bundled = readList(fs.readFileSync(BUNDLED_LIST, 'utf8'));
  } catch (err) {
    console.error('Disposable domain list not readable:', err.message);
  }
  disposableDomains = new Set([...bundled, ...EXTRA_DOMAINS]);
}

async function refreshList() {
  try {
    const response = await axios.get(LIST_URL, { timeout: 15000, responseType: 'text' });
    const fresh = readList(response.data);
    // A truncated or broken download must not shrink the list.
    if (fresh.length < 1000) throw new Error('only ' + fresh.length + ' lines received');
    disposableDomains = new Set([...fresh, ...EXTRA_DOMAINS]);
    console.log('Disposable domain list refreshed:', disposableDomains.size, 'domains');
  } catch (err) {
    console.warn('Disposable domain list not refreshed, keeping', disposableDomains.size, '-', err.message);
  }
}

// Called once by the server. Not started on require, so the start-up migration
// script can use canonicalEmail() without leaving timers running.
function startAutoRefresh() {
  setTimeout(refreshList, 30 * 1000).unref();
  setInterval(refreshList, REFRESH_EVERY_MS).unref();
}

function emailDomain(email) {
  return String(email || '').toLowerCase().trim().split('@')[1] || '';
}

// foo.bar.temp.com is as disposable as temp.com.
function inSetWithParents(domain, set) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function isListedDisposable(domain) {
  return inSetWithParents(domain, disposableDomains);
}

function disposableMxMatch(host) {
  return DISPOSABLE_MX.find(entry => host === entry || host.endsWith('.' + entry)) || null;
}

const mxCache = new Map();

// { status: 'ok' | 'none' | 'unknown', hosts: [...] }
// 'none' means the domain definitely has no mail server; 'unknown' means the
// lookup itself failed, and is never held against anyone.
async function lookupMx(domain) {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_CACHE_MS) return cached.result;

  let result;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS_TIMEOUT')), MX_TIMEOUT_MS))
    ]);
    result = {
      status: 'ok',
      hosts: records.map(r => String(r.exchange || '').toLowerCase().replace(/\.$/, ''))
    };
  } catch (err) {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'NXDOMAIN')) {
      result = { status: 'none', hosts: [] };
    } else {
      return { status: 'unknown', hosts: [] };
    }
  }

  mxCache.set(domain, { at: Date.now(), result });
  return result;
}

// { ok: true } or { ok: false, code, reason }.
async function assessEmail(email) {
  const domain = emailDomain(email);
  if (!domain || !domain.includes('.')) {
    return { ok: false, code: 'EMAIL_UNDELIVERABLE', reason: 'no domain' };
  }

  if (isListedDisposable(domain)) {
    return { ok: false, code: 'DISPOSABLE_EMAIL', reason: 'listed disposable domain' };
  }

  const mx = await lookupMx(domain);

  if (mx.status === 'none') {
    return { ok: false, code: 'EMAIL_UNDELIVERABLE', reason: 'no mail server' };
  }

  if (mx.status === 'ok') {
    // "MX 0 ." (RFC 7505) and localhost both mean "this domain takes no mail".
    const real = mx.hosts.filter(h => h && h !== 'localhost');
    if (!real.length) {
      return { ok: false, code: 'EMAIL_UNDELIVERABLE', reason: 'domain accepts no mail' };
    }
    for (const host of real) {
      const match = disposableMxMatch(host);
      if (match) {
        return { ok: false, code: 'DISPOSABLE_EMAIL', reason: 'disposable mail server ' + host };
      }
    }
  } else {
    console.warn('MX lookup inconclusive for', domain, '- allowing');
  }

  return { ok: true };
}

// The inbox an address actually delivers to. Gmail ignores dots and anything
// after "+", and googlemail.com is the same service; "+tag" is honoured by most
// large providers. So ivan+2@gmail.com, i.van@gmail.com and ivan@googlemail.com
// are all one mailbox — and one person.
function canonicalEmail(email) {
  const normalized = String(email || '').toLowerCase().trim();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;

  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';

  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');

  return local + '@' + domain;
}

loadBundledList();

module.exports = {
  assessEmail,
  canonicalEmail,
  emailDomain,
  isListedDisposable,
  lookupMx,
  disposableMxMatch,
  startAutoRefresh,
  refreshList
};
