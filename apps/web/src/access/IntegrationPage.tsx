import type { Api, Me } from '../api/client.js';
import { GitHubSyncSection } from './GitHubSyncSection.js';
import { S3KeysSection } from './S3KeysSection.js';

/** Administration > Integration: how other systems reach CT Studio's data (S3 keys, ADR 0008). */
export function IntegrationPage({ api, me }: { api: Api; me: Me }) {
  if (me.role !== 'admin') return <p>Admins only.</p>;
  return (
    <div className="access-page">
      <GitHubSyncSection api={api} />
      <S3KeysSection api={api} />
    </div>
  );
}
