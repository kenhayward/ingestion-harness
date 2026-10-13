import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { PREVIEW_DEADLINE_MS, useSegmentPreview } from '../src/workbench/useSegmentPreview.js';
import { fakeApi, segmentationView } from './fake-api.js';

const grid = { anchorErrors: {}, samples: [], suggestions: [] };

describe('useSegmentPreview', () => {
  it('starts a preview and polls until it finishes', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
      getSegmentation: vi
        .fn()
        .mockResolvedValueOnce(segmentationView({ jobId: 'j1', status: 'running' }))
        .mockResolvedValue(segmentationView({ jobId: 'j1', status: 'succeeded', result: grid })),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.view?.status).toBe('succeeded'));
    expect(result.current.running).toBe(false);
    expect(result.current.view?.result).toEqual(grid);
  });

  it('ignores a superseded preview', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const api = fakeApi({
      startSegmentation: vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
        .mockResolvedValueOnce(segmentationView({ jobId: 'j2', status: 'queued' })),
      getSegmentation: vi.fn(async (_p: string, jobId: string) => {
        if (jobId === 'j1') throw new ApiError('segmentation not found', 404);
        return segmentationView({ jobId: 'j2', status: 'succeeded', result: grid });
      }),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.view?.jobId).toBe('j2'));
    await act(async () => resolveFirst(segmentationView({ jobId: 'j1', status: 'queued' })));
    expect(result.current.view?.jobId).toBe('j2');
    expect(result.current.error).toBeNull();
  });

  it('re-issues the preview once when its own job was replaced on the server', async () => {
    const api = fakeApi({
      startSegmentation: vi
        .fn()
        .mockResolvedValueOnce(segmentationView({ jobId: 'j1', status: 'queued' }))
        .mockResolvedValueOnce(segmentationView({ jobId: 'j2', status: 'queued' })),
      getSegmentation: vi.fn(async (_p: string, jobId: string) => {
        if (jobId === 'j1') throw new ApiError('segmentation not found', 404);
        return segmentationView({ jobId: 'j2', status: 'succeeded', result: grid });
      }),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.view?.jobId).toBe('j2'));
    expect(api.startSegmentation).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.running).toBe(false);
  });

  it('asks for a manual retry when the re-issued preview is replaced too', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
      getSegmentation: vi.fn(async () => {
        throw new ApiError('segmentation not found', 404);
      }),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() =>
      expect(result.current.error).toBe('Preview was replaced; click Preview to try again'),
    );
    expect(api.startSegmentation).toHaveBeenCalledTimes(2);
    expect(result.current.running).toBe(false);
  });

  it('reports a refused preview', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () => {
        throw new ApiError('no prepared samples to segment', 409);
      }),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.error).toBe('no prepared samples to segment'));
  });

  it('reports a finished preview that has no result', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () =>
        segmentationView({ status: 'succeeded', error: 'result missing', result: null }),
      ),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.error).toBe('result missing'));
  });

  it('says so when a succeeded preview has neither result nor error', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () => segmentationView({ status: 'succeeded' })),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.error).toBe('preview finished without a result'));
  });

  it('gives up once the deadline has passed', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(PREVIEW_DEADLINE_MS + 1);
    const api = fakeApi({
      startSegmentation: vi.fn(async () => segmentationView({ status: 'queued' })),
      getSegmentation: vi.fn(async () => segmentationView({ status: 'running' })),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() =>
      expect(result.current.error).toBe('Preview timed out — is the worker running?'),
    );
    now.mockRestore();
  });

  it('shows the reason a preview needs review', async () => {
    const api = fakeApi({
      startSegmentation: vi.fn(async () =>
        segmentationView({ status: 'needs_review', error: 'preview took longer than 10s' }),
      ),
    });
    const { result } = renderHook(() => useSegmentPreview(api, 'letter', 1));
    act(() => result.current.preview());
    await waitFor(() => expect(result.current.error).toBe('preview took longer than 10s'));
  });
});
