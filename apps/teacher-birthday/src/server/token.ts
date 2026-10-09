import { createHmac, timingSafeEqual } from "node:crypto";

const sign = (recordId: string, year: number, pepper: string) =>
  createHmac("sha256", pepper).update(`${recordId}:${year}`).digest("base64url").slice(0, 22);

export function signPageToken(recordId: string, year: number, pepper: string): string {
  return `${recordId}.${year}.${sign(recordId, year, pepper)}`;
}

export function verifyPageToken(token: string, pepper: string): { recordId: string; year: number } | null {
  const [recordId, yearText, signature, ...rest] = token.split(".");
  const year = Number(yearText);
  if (rest.length || !recordId || !signature || !Number.isInteger(year)) return null;
  const expected = Buffer.from(sign(recordId, year, pepper));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { recordId, year } : null;
}
