import { describe, it, expect } from 'vitest';
import { npcInitiativePortrait } from '../npcPortrait';

/** The tracker goes to every player, so a face the GM silhouetted never enters it. */
describe('npcInitiativePortrait', () => {
  const FACE = '/uploads/headshots/face.png';

  it('keeps a portrait that is not silhouetted', () => {
    for (const off of [0, '0', null, undefined]) expect(npcInitiativePortrait(FACE, off)).toBe(FACE);
  });

  it('drops a silhouetted one, so the row draws its NPC marker', () => {
    for (const on of [1, '1']) expect(npcInitiativePortrait(FACE, on)).toBeUndefined();
  });

  it('has nothing to give without a portrait', () => {
    expect(npcInitiativePortrait(null, 0)).toBeUndefined();
    expect(npcInitiativePortrait(undefined, 0)).toBeUndefined();
  });
});
