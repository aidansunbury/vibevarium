import { Composition } from "remotion";
import { loadFonts } from "./fonts";
import { FPS, TOTAL_FRAMES } from "./constants";
import { Promo } from "./Promo";

loadFonts();

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Promo"
      component={Promo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
