import { waitUntil } from '@vercel/functions';
import { getGlobalTraceProvider, withTrace } from '@openai/agents';
import { screenResume } from '../agents/screener.js';
import { SupabaseStore } from '../data/supabaseStore.js';
import { emptyUsage } from '../lib/usage.js';
import type { Usage } from '../lib/runEvents.js';
import { screenedDetail } from './activity.js';
import { finishUsage, isProduction } from './limits.js';

export type ScreeningOutcome = { ok: boolean; usage: Usage; responseIds: string[] };

// Runs the Screener on a stored resume and saves the result. A failure is saved too (screened_at
// set, no screening), so the board can offer a retry; the applicant is kept either way. The
// screening is advisory: nothing here changes a stage, a booking or an approval.
export async function runScreening(
  sandboxId: string,
  applicantId: string,
  role: string,
  resumeText: string,
  usageId: number,
): Promise<ScreeningOutcome> {
  const store = new SupabaseStore(sandboxId);
  let usage = emptyUsage();
  try {
    // Test only, ignored in production: makes every screening fail, to exercise the retry.
    if (!isProduction() && process.env.LIVE_TEST_FAIL_SCREENING === '1') throw new Error('LIVE_TEST_FAIL_SCREENING');
    const outcome = await withTrace('Live resume screening', () => screenResume(role, resumeText), { groupId: sandboxId });
    usage = outcome.usage;
    await store.saveScreening(applicantId, outcome.screening);
    await store.addAudit(applicantId, 'screened', screenedDetail(outcome.screening));
    console.log(`[screening] ${applicantId} -> ${outcome.screening.fit}, ${outcome.screening.concerns.length} concern(s), injectionAttempt=${outcome.screening.injectionAttempt}`);
    return { ok: true, usage, responseIds: outcome.responseIds };
  } catch (error) {
    console.error(`[screening] ${applicantId} failed:`, error instanceof Error ? error.message : error);
    try {
      await store.saveScreening(applicantId, null);
    } catch (saveError) {
      console.error(`[screening] saving the failure for ${applicantId} failed:`, saveError instanceof Error ? saveError.message : saveError);
    }
    return { ok: false, usage, responseIds: [] };
  } finally {
    await finishUsage(usageId, usage);
    waitUntil(getGlobalTraceProvider().forceFlush());
  }
}
