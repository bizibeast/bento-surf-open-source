import { normalizeEmailRecipient } from "./email-recipient";

/**
 * Small, maintained list of disposable and test inboxes. Subdomains match.
 * Plus-addresses stay deliverable unless the tag is a test marker (`test`,
 * `qa`, `googleoauth`), which is how local and review accounts are named.
 */
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "caps7.com",
  "discard.email",
  "dispostable.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "trashmail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);
const RESERVED_TLDS = new Set(["example", "invalid", "localhost", "test"]);
const TEST_PLUS_TAG = /^(?:test\d*|qa\d*|googleoauth[a-z0-9]*)$/;

function domainBlocked(domain: string) {
  if (RESERVED_DOMAINS.has(domain)) return true;
  const labels = domain.split(".");
  const tld = labels.at(-1);
  if (tld && RESERVED_TLDS.has(tld)) return true;
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(index).join("."))) return true;
  }
  return false;
}

function hasTestPlusTag(local: string) {
  const plus = local.indexOf("+");
  if (plus < 0) return false;
  return local
    .slice(plus + 1)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => TEST_PLUS_TAG.test(token));
}

export function isDisposableOrTestEmail(value: string) {
  const email = normalizeEmailRecipient(value);
  if (!email) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return domainBlocked(domain) || hasTestPlusTag(local);
}
