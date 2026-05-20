import type { NormalisedShot } from "../../shared/domain/shot";

export const SHOT_PERSISTED_EVENT = "shot.persisted";

export class ShotPersistedEvent {
  constructor(public readonly shot: NormalisedShot) {}
}
