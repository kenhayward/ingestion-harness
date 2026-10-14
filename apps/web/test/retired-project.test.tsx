import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RETIRED_REASON } from '../src/ui/retired.js';
import { EvaluateTab } from '../src/workbench/EvaluateTab.js';
import { GateCard } from '../src/workbench/GateCard.js';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import { ReviseTab } from '../src/workbench/ReviseTab.js';
import { RunsTab } from '../src/workbench/RunsTab.js';
import { SamplesTab } from '../src/workbench/SamplesTab.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { SurveyTab } from '../src/workbench/SurveyTab.js';
import {
  fakeApi,
  projectOverview,
  projectView,
  publishGateView,
  referenceInfo,
  referenceRow,
  sampleView,
} from './fake-api.js';

const R = RETIRED_REASON;
const blockedByRetirement = async (name: string | RegExp) => {
  const button = await screen.findByRole('button', { name });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', R);
};
const item = projectOverview().stages[0]!;

describe('a retired project disables every job-creating action with the reason', () => {
  it('Samples: adding samples', async () => {
    render(<SamplesTab api={fakeApi()} projectId="letter" pollMs={60_000} retired={R} />);
    const input = await screen.findByLabelText('Add sample documents');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('title', R);
  });

  it('Test runs: Run on n dev samples', async () => {
    const api = fakeApi({ listSamples: vi.fn(async () => [sampleView()]) });
    render(
      <RunsTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        draft={4}
        item={item}
        pollMs={60_000}
        onChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement(/^Run on/);
  });

  it('Outputs: Propose outputs', async () => {
    render(
      <StagePanel
        api={fakeApi()}
        projectId="letter"
        stage="outputs"
        dataPolicy="local"
        hasDraft
        pollMs={1}
        onApplied={vi.fn()}
        onSkipped={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement('Propose outputs');
  });

  it('Survey: Run survey', async () => {
    render(
      <SurveyTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        brief={null}
        onBriefSaved={vi.fn()}
        pollMs={1}
        retired={R}
      />,
    );
    await blockedByRetirement('Run survey');
  });

  it('Revise: Ask the model for a revision', async () => {
    render(
      <ReviseTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        draft={4}
        pollMs={60_000}
        onApplied={vi.fn()}
        onChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement('Ask the model for a revision');
  });

  it('Evaluate: Evaluate and Compare models', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listReferenceRows: vi.fn(async () => [referenceRow({ reference: referenceInfo() })]),
    });
    render(
      <EvaluateTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        draft={2}
        published={null}
        pollMs={1}
        onRestored={vi.fn()}
        onStarted={vi.fn()}
        onGateChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement(/^Evaluate v2 on dev/);
    await blockedByRetirement('Compare models…');
  });

  it('References: the dev reference runs', async () => {
    render(
      <ReferencesTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        draft={2}
        published={1}
        item={item}
        pollMs={1}
        onChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement(/^Run the draft model on/);
  });

  it('Gate card: Publish', async () => {
    render(
      <GateCard
        api={fakeApi()}
        projectId="letter"
        draft={2}
        published={1}
        gate={publishGateView()}
        publications={[]}
        threshold={{ value: 0.9, setBy: null, setAt: null }}
        devScore={null}
        onChanged={vi.fn()}
        onPublished={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement('Publish v2');
  });
});
