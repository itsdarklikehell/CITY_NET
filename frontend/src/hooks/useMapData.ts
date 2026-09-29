import { useState, useCallback, useRef } from 'react';
import type { Location, District, Road, WaterBody } from '../types';
import type { SignData } from '../modules/signs';

export function useMapData() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [roads, setRoads] = useState<Road[]>([]);
  const [waterBodies, setWaterBodies] = useState<WaterBody[]>([]);
  const [overpasses, setOverpasses] = useState<any[]>([]);
  const [signs, setSigns] = useState<SignData[]>([]);

  // The GM's sign-in, sent with the location list: NPC sheets (for initiative rolls) and
  // silhouetted faces only come back to someone who may open those sheets. A ref, so signing
  // in does not give fetchLocations a new identity for everything that depends on it.
  const authToken = useRef('');
  const setMapAuthToken = useCallback((token: string) => { authToken.current = token; }, []);

  const fetchLocations = useCallback(() => {
    const headers: Record<string, string> = authToken.current ? { Authorization: `Bearer ${authToken.current}` } : {};
    fetch(`/api/locations?_t=${Date.now()}`, { headers })
      .then(res => res.json())
      .then(data => setLocations(data))
      .catch(err => console.error('Error fetching locations:', err));
  }, []);

  const fetchDistricts = useCallback(() => {
    fetch(`/api/districts?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setDistricts(data))
      .catch(err => console.error('Error fetching districts:', err));
  }, []);

  const fetchRoads = useCallback(() => {
    fetch(`/api/roads?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setRoads(data))
      .catch(err => console.error('Error fetching roads:', err));
  }, []);

  const fetchWaterBodies = useCallback(() => {
    fetch(`/api/water?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setWaterBodies(data))
      .catch(err => console.error('Error fetching water:', err));
  }, []);

  const fetchOverpasses = useCallback(() => {
    fetch(`/api/overpasses?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setOverpasses(data))
      .catch(err => console.error('Error fetching overpasses:', err));
  }, []);

  const fetchSigns = useCallback(() => {
    fetch(`/api/signs?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setSigns(data))
      .catch(err => console.error('Error fetching signs:', err));
  }, []);

  const fetchAll = useCallback(() => {
    fetchLocations();
    fetchDistricts();
    fetchRoads();
    fetchWaterBodies();
    fetchOverpasses();
    fetchSigns();
  }, [fetchLocations, fetchDistricts, fetchRoads, fetchWaterBodies, fetchOverpasses, fetchSigns]);

  return {
    locations, setLocations,
    districts, setDistricts,
    roads, setRoads,
    waterBodies, setWaterBodies,
    overpasses, setOverpasses,
    signs, setSigns,
    fetchLocations, fetchDistricts, fetchRoads, fetchWaterBodies, fetchOverpasses, fetchSigns, fetchAll,
    setMapAuthToken,
  };
}
