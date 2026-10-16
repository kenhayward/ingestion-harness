import { MemoryGitHubSyncRepo } from '../src/github-sync/repo.js';
import { MemoryTemplateRepo } from '../src/templates/repo.js';
import { githubSyncContract } from './github-sync-contract.js';

githubSyncContract('memory', async () => ({
  repo: new MemoryGitHubSyncRepo(),
  templates: new MemoryTemplateRepo(),
}));
