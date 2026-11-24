import { publicUrl } from './public-http.ts';

/** Parse and enforce the same public-HTTPS host policy used by publicHttp(). */
export function validateScraperUrl(raw: string): URL {
  return publicUrl(raw);
}
