import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMapData } from '../useMapData';

/** NPC sheets and silhouetted faces come with the map list only for a signed-in GM. */
describe('useMapData location list', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ json: () => Promise.resolve([]) } as Response));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const authOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization;

  it('asks anonymously until someone signs in', async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useMapData());
    act(() => result.current.fetchLocations());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(authOf(fetchMock.mock.calls[0][1])).toBeUndefined();
  });

  it("sends the GM's sign-in once it is set, and stops after sign-out", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useMapData());
    const before = result.current.fetchLocations;

    act(() => { result.current.setMapAuthToken('gm-token'); result.current.fetchLocations(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(authOf(fetchMock.mock.calls[0][1])).toBe('Bearer gm-token');

    act(() => { result.current.setMapAuthToken(''); result.current.fetchLocations(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(authOf(fetchMock.mock.calls[1][1])).toBeUndefined();

    // Signing in does not hand everything that depends on fetchLocations a new function.
    expect(result.current.fetchLocations).toBe(before);
  });
});
