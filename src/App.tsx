import './App.css'
import { AppShell } from './lib/ui/app/app-shell'
import { useAppController } from './lib/ui/app/use-app-controller'

function App() {
  return <AppShell controller={useAppController()} />
}

export default App
