import { z } from 'zod';
import { endpoint, json, readBody } from '../src/server/http.js';
import { createSandbox, getState, touchSandbox } from '../src/server/sandbox.js';

const Body = z.object({ sandboxId: z.uuid().optional() });

// Continues an existing sandbox, or creates a new one seeded with the five fake applicants.
export const POST = endpoint('sandbox', async (request) => {
  const { sandboxId } = await readBody(request, Body);
  const id = sandboxId && (await touchSandbox(sandboxId)) ? sandboxId : await createSandbox();
  return json({ sandboxId: id, created: id !== sandboxId, state: await getState(id) });
});
