import React from "react";
import { Series } from "remotion";
import { FPS, SCENES } from "./constants";
import { Seed } from "./scenes/Seed";
import { Command } from "./scenes/Command";
import { Tree } from "./scenes/Tree";
import { Garden } from "./scenes/Garden";
import { Control } from "./scenes/Control";
import { Keys } from "./scenes/Keys";
import { Wordmark } from "./scenes/Wordmark";

const s = (seconds: number): number => Math.round(seconds * FPS);

/**
 * vibevarium promo — the narrative arc:
 *  I. the seed        an acorn is sealed into a glass jar
 *  II. one command    `vibevarium grow` types itself out
 *  III. self-contained the sprout becomes a tree of app parts
 *  IV. the garden     the camera pulls back to a shelf of jars
 *  V. the gardener    light interlude: the control plane ledger
 *  VI. one key        a single OIDC token unlocks everything
 *  VII. wordmark      vibevarium — grown, not built
 */
export const Promo: React.FC = () => {
  return (
    <Series>
      <Series.Sequence durationInFrames={s(SCENES.seed)}>
        <Seed />
      </Series.Sequence>
      <Series.Sequence durationInFrames={s(SCENES.command)}>
        <Command />
      </Series.Sequence>
      <Series.Sequence durationInFrames={s(SCENES.tree)}>
        <Tree />
      </Series.Sequence>
      <Series.Sequence durationInFrames={s(SCENES.garden)}>
        <Garden />
      </Series.Sequence>
      <Series.Sequence durationInFrames={s(SCENES.control)}>
        <Control />
      </Series.Sequence>
      <Series.Sequence durationInFrames={s(SCENES.keys)}>
        <Keys />
      </Series.Sequence>
      <Series.Sequence durationInFrames={s(SCENES.wordmark)}>
        <Wordmark />
      </Series.Sequence>
    </Series>
  );
};
