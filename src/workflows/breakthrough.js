/* A breakthrough turn as a Workflow, so it runs to the end whatever the
 * browser does. The turn itself is in lib/breakthrough-turn.js; this only
 * hands it the Workflow's steps. */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { runTurn } from '../lib/breakthrough-turn.js';

export class BreakthroughWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runTurn({ env: this.env, messageId: event.payload.messageId, step });
  }
}
