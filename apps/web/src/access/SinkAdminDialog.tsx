import { useCallback, useEffect, useState } from 'react';
import type { AdminInstance } from '@ih/bridge-contract';
import type { SinkInfo } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Segmented, type SegmentedOption } from '../ui/Segmented.js';
import { SinkAudit } from './SinkAudit.js';
import { SinkClients } from './SinkClients.js';
import { SinkInstances } from './SinkInstances.js';

type Section = 'instances' | 'clients' | 'audit';

/** An instance a client may be issued for: the sink's administered ones, else those it describes. */
export interface InstanceChoice {
  id: string;
  label: string;
}

/**
 * Administration of one sink (contract version 3), from a target row of Published outputs: its
 * Instances, Clients and Audit log, each shown only when the sink declares it. Every call goes
 * through the API to the delivery bridge, as the signed-in admin. An issued client's token is
 * held only while its panel is open.
 */
export function SinkAdminDialog({
  api,
  sink,
  onClose,
}: {
  api: Api;
  sink: SinkInfo;
  onClose: () => void;
}) {
  const offered = sink.capabilities.administration;
  const options: SegmentedOption<Section>[] = [
    ...(offered?.instances ? [{ value: 'instances' as const, label: 'Instances' }] : []),
    ...(offered?.clients
      ? [
          { value: 'clients' as const, label: 'Clients' },
          { value: 'audit' as const, label: 'Audit log' },
        ]
      : []),
  ];
  const [section, setSection] = useState<Section>(options[0]?.value ?? 'audit');
  const [instances, setInstances] = useState<AdminInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInstances = useCallback(async () => {
    if (!offered?.instances) return;
    try {
      setInstances(await api.listSinkInstances(sink.id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, sink.id, offered?.instances]);

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);

  const choices: InstanceChoice[] = offered?.instances
    ? (instances ?? []).map((i) => ({ id: i.id, label: i.label }))
    : sink.instances;

  return (
    <Dialog
      title={`Administer ${sink.name}`}
      onClose={onClose}
      closeLabel="Close"
      className="target-dialog"
    >
      {options.length > 1 && (
        <Segmented label="Section" options={options} value={section} onChange={setSection} />
      )}
      {section === 'instances' && (
        <SinkInstances
          api={api}
          sinkId={sink.id}
          fields={offered?.instanceFields ?? []}
          instances={instances}
          error={error}
          onChanged={loadInstances}
        />
      )}
      {section === 'clients' && <SinkClients api={api} sinkId={sink.id} choices={choices} />}
      {section === 'audit' && <SinkAudit api={api} sinkId={sink.id} />}
    </Dialog>
  );
}
