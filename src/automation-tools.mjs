import { z } from 'zod';

export function registerAutomationTools(register, server, runtime) {
  const id = { automationId: z.string().uuid() };
  const trigger = z.discriminatedUnion('type', [
    z.object({ type: z.literal('event'), eventType: z.string().min(1).max(64) }),
    z.object({ type: z.literal('once'), at: z.string().min(1).max(100) }),
    z.object({ type: z.literal('interval'), everySeconds: z.number().int().min(60).max(31536000),
      startAt: z.string().max(100).optional() }),
    z.object({ type: z.literal('daily'), time: z.string().max(5), timeZone: z.string().min(1).max(100) })
  ]);

  register('create_automation', 'Save a disabled draft for a fixed repository, goal and schedule or event. ' +
    'Creating a definition does not authorize model execution.',
    { name: z.string().trim().min(1).max(100), repository: z.string().min(1),
      goal: z.string().trim().min(1).max(20000), agents: z.array(z.string()).min(1).max(8).optional(),
      trigger, includeEventPayload: z.boolean().optional() },
    input => runtime.automations.create(input));

  register('list_automations', 'List automation definitions, enablement and next scheduled occurrences.',
    {}, () => ({ automations: runtime.automations.list(), health: runtime.automations.health() }), true);

  register('get_automation', 'Inspect one automation and its latest 100 run records, including task IDs.',
    id, ({ automationId }) => runtime.automations.get(automationId), true);

  register('review_automation', 'Ask the human to authorize future runs of this exact automation. ' +
    'Existing per-stage approval checkpoints remain in effect.',
    id, async ({ automationId }) => {
      const rule = runtime.automations.store.get(automationId);
      if (rule.enabled) return rule;
      if (!server.server.getClientCapabilities()?.elicitation) throw new Error('MCP form elicitation is required.');
      const response = await server.server.elicitInput({
        mode: 'form', message: 'Enable future model runs for this automation? It will use configured credentials and checks. ' +
          'Per-stage approvals: ' + String(runtime.config.requireApproval ?? false) + '. ' +
          JSON.stringify({ name: rule.name, repository: rule.repository, goal: rule.goal,
            agents: rule.agents, trigger: rule.trigger, includeEventPayload: rule.includeEventPayload }),
        requestedSchema: { type: 'object', properties: {
          approve: { type: 'boolean', title: 'Authorize this automation', default: false }
        }, required: ['approve'] }
      });
      if (response.action !== 'accept' || response.content?.approve !== true) return runtime.automations.store.get(automationId);
      return runtime.automations.enable(automationId);
    });

  register('disable_automation', 'Disable future triggers and cancel undispatched runs. ' +
    'Already-started tasks remain available for review or cancellation.',
    id, ({ automationId }) => runtime.automations.disable(automationId));

  register('trigger_event', 'Deliver a named event to already-approved matching automations. ' +
    'Reuse the same event ID for retries. The event cannot select a new goal or agent.',
    { eventId: z.string().min(1).max(100), type: z.string().min(1).max(64),
      repository: z.string().optional(), payload: z.record(z.unknown()).optional() },
    ({ eventId, ...rest }) => runtime.automations.event({ id: eventId, ...rest }));
}
