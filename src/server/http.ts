import { timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';

// An error whose message is safe to show in the browser.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Every endpoint requires x-demo-code to equal DEMO_PASSCODE. timingSafeEqual needs buffers of
// equal length, so a wrong-length code is compared against itself and then rejected.
export function requirePasscode(request: Request): void {
  const expected = process.env.DEMO_PASSCODE;
  if (!expected) throw new Error('DEMO_PASSCODE is not set');
  const given = Buffer.from(request.headers.get('x-demo-code') ?? '', 'utf8');
  const want = Buffer.from(expected, 'utf8');
  const sameLength = given.length === want.length;
  const equal = timingSafeEqual(sameLength ? given : want, want);
  if (!sameLength || !equal) throw new HttpError(401, 'That access code is not valid.');
}

export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'The request body must be JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'request';
    throw new HttpError(400, `Invalid ${field}: ${issue?.message ?? 'check the input'}.`);
  }
  return parsed.data;
}

// Wraps a handler: checks the passcode, turns HttpError into its status and message, and turns
// anything else into a plain 500. Details are logged on the server only, never returned.
export function endpoint(name: string, handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      requirePasscode(request);
      return await handler(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(`[api] ${name} failed:`, error instanceof Error ? (error.stack ?? error.message) : error);
      return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
    }
  };
}
