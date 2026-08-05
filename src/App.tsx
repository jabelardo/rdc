import "./App.css";
import { AppShell } from "./lib/ui/app/app-shell";
import { ThemeProvider } from "./lib/ui/theme-provider";
import { useAppController } from "./lib/ui/app/use-app-controller";

function App() {
  return (
    <ThemeProvider>
      <AppShell controller={useAppController()} />
    </ThemeProvider>
  );
}

export default App;
