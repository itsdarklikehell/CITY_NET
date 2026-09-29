/**
 * The portrait an NPC's initiative entry may carry.
 *
 * The tracker goes to every player and draws its portraits as plain images, so a face the GM
 * silhouetted would show there in full. A silhouetted NPC therefore enters with none, and the
 * row draws its NPC marker instead.
 */
export const npcInitiativePortrait = (
  url: string | null | undefined,
  shadowFilter: number | string | null | undefined,
): string | undefined => (!url || Number(shadowFilter ?? 0) !== 0 ? undefined : url);
