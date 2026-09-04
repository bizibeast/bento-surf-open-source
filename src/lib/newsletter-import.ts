import { normalizeEmailRecipient } from "./email-recipient";

export type SubscriberImportRow = {
  email: string;
  name?: string;
  list?: string;
};

export type SubscriberColumnMapping = {
  email: string;
  name?: string;
  list?: string;
};

export type SubscriberCsvErrorCode =
  | "malformed_csv"
  | "missing_email_header"
  | "duplicate_header"
  | "invalid_email"
  | "name_too_long"
  | "list_too_long"
  | "row_limit_exceeded";

export type SubscriberCsvError = {
  code: SubscriberCsvErrorCode;
  row: number;
};

export function summarizeSubscriberImportCapacity(
  emails: string[],
  contacts: Array<{ email_normalized: string; marketing_status: string }>,
  remainingCapacity: number,
) {
  const byEmail = new Map(contacts.map((contact) => [contact.email_normalized, contact]));
  const existing = emails.filter((email) => byEmail.has(email)).length;
  const required = emails.filter(
    (email) => byEmail.get(email)?.marketing_status !== "subscribed",
  ).length;
  return { existing, required, blocked: Math.max(0, required - remainingCapacity) };
}

const MAX_ROWS = 10_000;
function csvRecords(text: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== "," && character !== "\n" && character !== "\r") {
      return null;
    }
    if (character === '"') {
      if (field) return null;
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
      closedQuote = false;
    } else if (character === "\n" || character === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      closedQuote = false;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (quoted) return null;
  if (field || record.length) records.push([...record, field]);
  return records;
}

export function parseSubscriberCsv(
  text: string,
  mapping?: SubscriberColumnMapping,
): {
  headers: string[];
  rows: SubscriberImportRow[];
  errors: SubscriberCsvError[];
} {
  const records = csvRecords(text.replace(/^\uFEFF/, ""));
  if (!records) {
    return { headers: [], rows: [], errors: [{ code: "malformed_csv", row: 1 }] };
  }

  const headers = (records.shift() ?? []).map((header) => header.trim().toLowerCase());
  const emailHeader = mapping?.email.trim().toLowerCase() ?? "email";
  const nameHeader = mapping?.name?.trim().toLowerCase() ?? "name";
  const listHeader = mapping?.list?.trim().toLowerCase() ?? "list";
  const emailIndex = headers.indexOf(emailHeader);
  const errors: SubscriberCsvError[] = [];
  if (emailIndex < 0) errors.push({ code: "missing_email_header", row: 1 });
  const mappedHeaders = mapping
    ? [emailHeader, mapping.name ? nameHeader : "", mapping.list ? listHeader : ""].filter(Boolean)
    : [emailHeader, nameHeader, listHeader];
  if (new Set(mappedHeaders).size !== mappedHeaders.length) {
    errors.push({ code: "duplicate_header", row: 1 });
  }
  for (const header of mappedHeaders) {
    if (headers.indexOf(header) !== headers.lastIndexOf(header)) {
      errors.push({ code: "duplicate_header", row: 1 });
    }
  }
  if (errors.length) return { headers, rows: [], errors };

  const nameIndex = mapping
    ? mapping.name
      ? headers.indexOf(nameHeader)
      : -1
    : headers.indexOf("name");
  const listIndex = mapping
    ? mapping.list
      ? headers.indexOf(listHeader)
      : -1
    : headers.indexOf("list");
  const rows: SubscriberImportRow[] = [];
  let dataRows = 0;

  records.forEach((record, index) => {
    if (record.every((field) => !field.trim())) return;
    dataRows += 1;
    const row = index + 2;
    if (dataRows > MAX_ROWS) {
      if (dataRows === MAX_ROWS + 1) errors.push({ code: "row_limit_exceeded", row });
      return;
    }

    const email = normalizeEmailRecipient(record[emailIndex] ?? "");
    const name = nameIndex >= 0 ? (record[nameIndex] ?? "").trim() : "";
    const list = listIndex >= 0 ? (record[listIndex] ?? "").trim() : "";
    if (!email) {
      errors.push({ code: "invalid_email", row });
    } else if (name.length > 120) {
      errors.push({ code: "name_too_long", row });
    } else if (list.length > 80) {
      errors.push({ code: "list_too_long", row });
    } else {
      rows.push({ email, ...(name ? { name } : {}), ...(list ? { list } : {}) });
    }
  });

  return { headers, rows, errors };
}
