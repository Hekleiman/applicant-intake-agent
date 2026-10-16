import { z } from 'zod';
import { endpoint, HttpError, json, readBody } from '../src/server/http.js';
import { checkLimits, ipHash, startUsage } from '../src/server/limits.js';
import { chatTurn } from '../src/server/liveRun.js';
import { openPausedRuns, requireSandbox } from '../src/server/sandbox.js';

// Long enough for the guardrail to see (and refuse) an overlong message itself.
const Body = z.object({ sandboxId: z.uuid(), message: z.string().trim().min(1).max(8000) });

export const POST = endpoint('chat', async (request) => {
  const { sandboxId, message } = await readBody(request, Body);
  await requireSandbox(sandboxId);
  // A paused run leaves its tool call in the session without a result; a new run on top of it
  // would fail, so the approval has to be settled first.
  if ((await openPausedRuns(sandboxId)).length > 0) {
    throw new HttpError(409, 'Approve or decline the pending request first.');
  }
  const ip = ipHash(request);
  await checkLimits(sandboxId, ip);
  const usageId = await startUsage(sandboxId, ip, 'message');
  return json(await chatTurn(sandboxId, message, usageId));
});
