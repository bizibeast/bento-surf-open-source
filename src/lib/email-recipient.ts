const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmailRecipient(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.length >= 3 && normalized.length <= 254 && EMAIL_PATTERN.test(normalized)
    ? normalized
    : null;
}
