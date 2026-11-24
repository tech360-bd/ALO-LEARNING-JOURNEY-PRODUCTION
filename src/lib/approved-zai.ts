import { assertExternalAiAllowed } from './agentos/payment-guard.ts';

/** A legacy SDK connection may incur charges, even when a key is present. */
export async function createApprovedZai() {
  assertExternalAiAllowed('z-ai-web-dev-sdk');
  const { default: ZAI } = await import('z-ai-web-dev-sdk');
  return ZAI.create();
}
