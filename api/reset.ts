import { z } from 'zod';
import { endpoint, json, readBody } from '../src/server/http.js';
import { createSandbox, deleteSandbox, getState } from '../src/server/sandbox.js';

const Body = z.object({ sandboxId: z.uuid().optional() });

// Deletes the sandbox (everything in it cascades) and creates a fresh one.
export const POST = endpoint('reset', async (request) => {
  const { sandboxId } = await readBody(request, Body);
  if (sandboxId) await deleteSandbox(sandboxId);
  const id = await createSandbox();
  return json({ sandboxId: id, state: await getState(id) });
});
