import { z } from 'zod';
import { endpoint, HttpError, json } from '../src/server/http.js';
import { getState, requireSandbox } from '../src/server/sandbox.js';

export const GET = endpoint('state', async (request) => {
  const parsed = z.uuid().safeParse(new URL(request.url).searchParams.get('sandboxId'));
  if (!parsed.success) throw new HttpError(400, 'Invalid sandboxId.');
  await requireSandbox(parsed.data);
  return json({ state: await getState(parsed.data) });
});
