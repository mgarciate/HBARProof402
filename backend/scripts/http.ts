import 'dotenv/config';
import { randomUUID } from 'node:crypto';
export async function request(path: string, token: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  return result;
}
