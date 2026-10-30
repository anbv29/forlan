import { z } from 'zod';

export function registerContextTools(register, runtime) {
  const context = runtime.context;
  const root = { repository: z.string().min(1) };
  const repository = path => context.repository(runtime.config, path);
  register('index_repository', 'Refresh a local searchable text index. Indexes at most 2000 files and 10 MB. No model calls.',
    root, ({ repository }) => context.index(runtime.config, repository));
  register('search_context', 'Search indexed code and saved project decisions. Results may be stale until reindexing.',
    { ...root, query: z.string().min(1).max(2000) }, async args => {
      const path = await repository(args.repository);
      return { index: context.status(path), results: context.search(path, args.query) };
    }, true);
  register('remember_context', 'Save a repository-scoped decision or note for later agent tasks. Do not store credentials.',
    { ...root, title: z.string().min(1).max(200), body: z.string().min(1).max(20000) },
    async args => context.remember(await repository(args.repository), args.title, args.body));
  register('forget_context', 'Delete a saved repository note and its search entry.',
    { ...root, memoryId: z.string().uuid() },
    async args => context.forget(await repository(args.repository), args.memoryId));
}
