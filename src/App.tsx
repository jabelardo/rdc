import "./App.css";
import { LucideProvider } from "lucide-react";
import { AppShell } from "./lib/ui/app/app-shell";
import { ThemeProvider } from "./lib/ui/theme-provider";
import { useAppController } from "./lib/ui/app/use-app-controller";

function App() {
  return (
    <ThemeProvider>
      {/* Icons scale with the font size of wherever they sit, rather than lucide's fixed 24px.
       * This is what FontAwesome did — its injected stylesheet set `height: 1em` — so matching it
       * keeps the icon-library swap to a change of drawing style with no change in geometry.
       * Applied as a class rather than the `size` prop because lucide types `size` as a number;
       * CSS width/height override the SVG presentation attributes, so the class wins. The two
       * explicit sizes in App.css (.working-tree-file-status svg) are unlayered and so still beat
       * this utility, which is what keeps the status glyphs at their designed 7.8px and 13px. */}
      <LucideProvider className="size-[1em]">
        <AppShell controller={useAppController()} />
      </LucideProvider>
    </ThemeProvider>
  );
}

export default App;
