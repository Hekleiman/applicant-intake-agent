import OpenAI from 'openai';
import { setDefaultOpenAIClient } from '@openai/agents';

let responsesRequests = 0;

// Counts Responses API calls at the HTTP layer, independent of the SDK's own usage numbers.
const client = new OpenAI({
  fetch: (url, init) => {
    if (String(url).includes('/responses')) responsesRequests++;
    return fetch(url, init);
  },
});
setDefaultOpenAIClient(client);

export function takeRequestCount(): number {
  const count = responsesRequests;
  responsesRequests = 0;
  return count;
}
