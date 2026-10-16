import type { AppDeps } from '../app.js';
import { decryptSecret } from '../llm/secrets.js';

/**
 * The signed-in user's own GitHub token (their Profile link), never anyone else's; 'not_linked'
 * without a link, without `LLM_SECRETS_KEY`, or when the stored token can no longer be decrypted.
 */
export async function userToken(
  deps: Pick<AppDeps, 'profiles' | 'llmSecrets'>,
  userId: string,
): Promise<string | 'not_linked'> {
  const stored = (await deps.profiles.get(userId)).github;
  if (!stored || !deps.llmSecrets) return 'not_linked';
  try {
    return decryptSecret(stored.tokenEnc, deps.llmSecrets);
  } catch {
    return 'not_linked';
  }
}
