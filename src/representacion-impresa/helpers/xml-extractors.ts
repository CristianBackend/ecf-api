/**
 * Extracts tag content from signed XML using regex.
 * Returns the FIRST occurrence — sufficient for header-level fields
 * that appear only once in the document.
 */
export function extractXmlField(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`);
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Parses a DGII-formatted date string "dd-MM-yyyy" into a Date object.
 * Returns null on invalid input.
 * The Date is built at noon local time to avoid timezone edge-cases
 * when formatting back with formatDateDgii().
 */
export function parseDgiiDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, day, month, year] = m;
  return new Date(`${year}-${month}-${day}T12:00:00`);
}
