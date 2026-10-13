import { act, renderHook, waitFor } from '@testing-library/react';
import type { Api } from '../src/api/client.js';
import { describe, expect, it, vi } from 'vitest';
type TemplateRecordView = Awaited<ReturnType<Api['getTemplate']>>;
import { useDefinitions } from '../src/workbench/useDefinitions.js';
import { fakeApi, templateView } from './fake-api.js';

const def = (version: number) => ({ id: 'letter', version, outputs: { fields: [], tables: [] } });

function deferred() {
  let resolve!: (v: TemplateRecordView) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<TemplateRecordView>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useDefinitions', () => {
  it('ignores a superseded load that finishes late', async () => {
    const slow = deferred();
    const getTemplate = vi
      .fn()
      .mockReturnValueOnce(slow.promise)
      .mockImplementation(async (_id: string, v: number) => templateView(def(v)));
    const api = fakeApi({ getTemplate });
    const { result, rerender } = renderHook(
      ({ draft }) => useDefinitions(api, 'letter', draft, null, true),
      { initialProps: { draft: 1 } },
    );
    rerender({ draft: 2 });
    await waitFor(() => expect(result.current.draftDef?.version).toBe(2));
    await act(async () => slow.resolve(templateView(def(1))));
    expect(result.current.draftDef?.version).toBe(2);
  });

  it('keeps the draft when the live version cannot be loaded', async () => {
    const api = fakeApi({
      getTemplate: vi.fn(async (_id: string, v: number) => {
        if (v === 1) throw new Error('live gone');
        return templateView(def(v));
      }),
    });
    const { result } = renderHook(() => useDefinitions(api, 'letter', 2, 1, true));
    await waitFor(() => expect(result.current.draftDef?.version).toBe(2));
    expect(result.current.liveDef).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.liveError).toBe('live gone');
  });

  it('clears the definitions when the versions change', async () => {
    const second = deferred();
    const getTemplate = vi
      .fn()
      .mockImplementationOnce(async (_id: string, v: number) => templateView(def(v)))
      .mockReturnValueOnce(second.promise);
    const api = fakeApi({ getTemplate });
    const { result, rerender } = renderHook(
      ({ draft }) => useDefinitions(api, 'letter', draft, null, true),
      { initialProps: { draft: 1 } },
    );
    await waitFor(() => expect(result.current.draftDef?.version).toBe(1));
    rerender({ draft: 2 });
    await waitFor(() => expect(result.current.draftDef).toBeNull());
    await act(async () => second.reject(new Error('store down')));
    expect(result.current.error).toBe('store down');
    expect(result.current.draftDef).toBeNull();
  });
});
