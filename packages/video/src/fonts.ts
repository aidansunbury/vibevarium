import { loadFont as loadFraunces } from "@remotion/google-fonts/Fraunces";
import { loadFont as loadSourceSans } from "@remotion/google-fonts/SourceSans3";
import { loadFont as loadPlexMono } from "@remotion/google-fonts/IBMPlexMono";

export const loadFonts = (): void => {
  loadFraunces("normal", {
    weights: ["400", "600"],
    subsets: ["latin"],
  });
  loadFraunces("italic", {
    weights: ["400", "600"],
    subsets: ["latin"],
  });
  loadSourceSans("normal", {
    weights: ["400", "600"],
    subsets: ["latin"],
  });
  loadPlexMono("normal", {
    weights: ["400", "500"],
    subsets: ["latin"],
  });
};
