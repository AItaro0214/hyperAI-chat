/* How this deployment identifies itself to upstream providers.
 *
 * OpenRouter shows these on its activity page, and the TOTP issuer is what an
 * authenticator app displays next to the code. Neither is a secret; they are
 * kept in one place so a fork only has to change them once. */

export const APP_NAME = 'hyperAI-chat';
export const APP_URL = 'https://github.com/AItaro0214/hyperAI-chat';

/** Attribution headers OpenRouter accepts on every request. */
export const attribution = () => ({ 'HTTP-Referer': APP_URL, 'X-Title': APP_NAME });
