import "./assetPath.ts";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";

// No StrictMode: its double-invoked effects would load every image in the
// project twice on start-up, which is expensive for large scenes.
createRoot(document.getElementById("root")!).render(<App />);
