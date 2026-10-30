import { EventListener } from './event-listener.mjs';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AutomationStore } from './automation-store.mjs';
import { normalizeTrigger, nextOccurrence, eventType } from './schedules.mjs';
import { stagePlan } from './agents.mjs';
import { tickAutomations, refreshRuns, reserveRun, emitTaskEvent } from './automation-runner.mjs';

export class Automations {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.clock = options.clock ?? Date.now;
    this.store = new AutomationStore(runtime.store);
    this.ticking = false;
    if (runtime.config.automationWebhook) this.listener = new EventListener(this, runtime.config.automationWebhook);
    const period = runtime.config.automationTickMs ?? 1000;
    if (options.polling !== false && period) {
      this.timer = setInterval(() => this.tick(), period);
      this.timer.unref();
    }
  }

  async create(input) {
    const r = this.runtime;
    if (r.closing) throw new Error('Server is shutting down.');
    const repository = await realpath(input.repository);
    if (!r.config.repositories.includes(repository)) throw new Error('Repository is not configured.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Name must contain 1–100 characters.');
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 20000) throw new Error('Invalid automation goal.');
    if (input.includeEventPayload !== undefined && typeof input.includeEventPayload !== 'boolean') throw new Error('includeEventPayload must be boolean.');
    const agents = stagePlan(r.config, input.agents).map(stage => stage.agent);
    const trigger = normalizeTrigger(input.trigger, this.clock());
    return this.store.create({ name: input.name.trim(), goal: input.goal.trim(), repository,
      agents, trigger, includeEventPayload: input.includeEventPayload ?? false,
      createdAt: new Date(this.clock()).toISOString(), nextAt: null });
  }

  enable(id) {
    if (this.runtime.closing) throw new Error('Server is shutting down.');
    const rule = this.store.get(id);
    if (!this.runtime.config.repositories.includes(rule.repository)) throw new Error('Repository is no longer configured.');
    stagePlan(this.runtime.config, rule.agents);
    if (rule.enabled) return rule;
    const nextAt = nextOccurrence(rule.trigger, this.clock() - 1);
    if (rule.trigger.type === 'once' && !nextAt) throw new Error('One-off schedule has expired.');
    return this.store.update(id, { enabled: true, nextAt,
      approvedAt: new Date(this.clock()).toISOString() });
  }

  disable(id) { return this.store.disable(id); }

  event(input) {
    if (this.runtime.closing) throw new Error('Server is shutting down.');
    if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.id)) throw new Error('Invalid event id.');
    const type = eventType(input.type);
    if (input.repository !== undefined && typeof input.repository !== 'string') throw new Error('Invalid event repository.');
    const payload = input.payload ?? {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Buffer.byteLength(JSON.stringify(payload)) > 8192) throw new Error('Event payload must be an object below 8 KB.');
    const digest = createHash('sha256').update(JSON.stringify({ type, repository: input.repository, payload })).digest('hex');
    const prior = this.store.eventDigest(input.id);
    if (prior) {
      if (prior !== digest) throw new Error('Event id was already used with different content.');
      return { duplicate: true, eventId: input.id, runs: [] };
    }
    refreshRuns(this);
    const result = this.runtime.store.transaction(() => {
      this.store.recordEvent(input.id, digest);
      const runs = [];
      for (const rule of this.store.list()) {
        if (!rule.enabled || rule.trigger.type !== 'event' || rule.trigger.eventType !== type ||
          (input.repository && rule.repository !== input.repository)) continue;
        runs.push(reserveRun(this, rule, 'event:' + input.id, {
          eventId: input.id, eventType: type,
          ...(rule.includeEventPayload ? { payload: this.runtime.clean(payload) } : {})
        }));
        this.store.update(rule.id, { lastTriggeredAt: new Date(this.clock()).toISOString() });
      }
      return { duplicate: false, eventId: input.id, runs };
    });
    this.tick();
    return result;
  }

  list() { return this.store.list(); }

  get(id) { return { ...this.store.get(id), runs: this.store.runs(id) }; }

  health() {
    return { queuedRuns: this.store.queuedCount(), error: this.error ?? null,
      webhook: this.listener?.status() ?? { enabled: false } };
  }

  tick() { tickAutomations(this); }

  taskFinished(task) {
    try { emitTaskEvent(this, task); }
    catch (error) { this.error = 'Internal event could not be recorded.'; }
    this.tick();
  }

  async close() {
    clearInterval(this.timer);
    await this.listener?.close();
  }
}
