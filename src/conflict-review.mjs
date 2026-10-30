import { createHash } from 'node:crypto';
import { z } from 'zod';
import { captureChanges } from './plans.mjs';
import { mergeSnapshots } from './merge.mjs';

export async function conflictDetails(runtime, id) {
  const project = runtime.store.get(id);
  if (project.kind !== 'project' || project.status !== 'integration_conflict' || runtime.active.has(id)) {
    throw new Error('Project has no stopped integration conflict.');
  }
  const dependedOn = new Set(project.nodes.flatMap(node => node.dependsOn));
  const snapshots = [];
  for (const node of project.nodes.filter(node => !dependedOn.has(node.key))) {
    const child = runtime.store.get(node.taskId);
    if (child.status !== 'needs_review' || child.base !== project.base) throw new Error('Child worktree changed.');
    snapshots.push(await captureChanges(child));
  }
  const result = await mergeSnapshots(runtime.config, project, snapshots, undefined, { collectConflicts: true });
  const revision = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return { revision, conflicts: result.conflicts };
}

export function validateResolutions(conflicts, decisions) {
  const paths = [...new Set(conflicts.map(conflict => conflict.path))];
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions) ||
    Object.keys(decisions).length !== paths.length || paths.some(path => !Object.hasOwn(decisions, path))) {
    throw new Error('Provide exactly one content or null decision per conflicting path.');
  }
  for (const value of Object.values(decisions)) {
    if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 100000 ||
      /^(<<<<<<<|=======|>>>>>>>|\|{7})/m.test(value))) throw new Error('Invalid resolved content or remaining conflict markers.');
  }
  return decisions;
}

export function registerConflictTools(register, server, runtime) {
  register('get_conflict_details', 'Read base and competing text versions, including add/delete conflicts, with a revision hash.',
    { taskId: z.string().uuid() }, ({ taskId }) => conflictDetails(runtime, taskId), true);
  register('submit_conflict_resolutions', 'Ask the human to approve explicit file contents or deletion for every conflict. ' +
    'Supports add/add and delete/modify decisions without a model call. Configured checks run afterward.',
    { taskId: z.string().uuid(), revision: z.string().length(64),
      decisions: z.record(z.string().max(100000).nullable()) }, async ({ taskId, revision, decisions }) => {
      const details = await conflictDetails(runtime, taskId);
      if (details.revision !== revision) throw new Error('Conflict revision changed; inspect it again.');
      validateResolutions(details.conflicts, decisions);
      if (!server.server.getClientCapabilities()?.elicitation) throw new Error('MCP form elicitation is required.');
      const response = await server.server.elicitInput({ mode: 'form',
        message: 'Apply these explicit conflict decisions and run checks? Review the supplied contents before approval. ' +
          JSON.stringify(decisions), requestedSchema: { type: 'object', properties: {
          approve: { type: 'boolean', title: 'Apply conflict decisions', default: false }
        }, required: ['approve'] } });
      if (response.action !== 'accept' || response.content?.approve !== true) return { id: taskId, status: 'integration_conflict' };
      const current = await conflictDetails(runtime, taskId);
      if (current.revision !== revision) throw new Error('Conflict changed during review.');
      if (runtime.closing || runtime.active.has(taskId) || runtime.active.size >= runtime.config.maxConcurrent) {
        throw new Error('Runtime is busy or shutting down.');
      }
      const task = runtime.store.update(taskId, { phase: 'resolution', status: 'queued',
        resolutionDecisions: decisions, resolutionRevision: revision });
      runtime.launch(task);
      return task;
    });
}
