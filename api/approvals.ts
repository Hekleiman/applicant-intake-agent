import { z } from 'zod';
import { endpoint, json, readBody } from '../src/server/http.js';
import { checkLimits, ipHash, startUsage } from '../src/server/limits.js';
import { resolveApproval } from '../src/server/liveRun.js';
import { requireSandbox } from '../src/server/sandbox.js';

const Body = z.object({
  sandboxId: z.uuid(),
  pausedRunId: z.uuid(),
  decisions: z.array(z.object({ callId: z.string().min(1).max(200), approve: z.boolean() })).min(1).max(10),
});

export const POST = endpoint('approvals', async (request) => {
  const { sandboxId, pausedRunId, decisions } = await readBody(request, Body);
  await requireSandbox(sandboxId);
  const ip = ipHash(request);
  await checkLimits(sandboxId, ip);
  const usageId = await startUsage(sandboxId, ip, 'approval');
  return json(await resolveApproval(sandboxId, pausedRunId, decisions, usageId));
});
