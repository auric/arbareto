// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Suspense, use, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBridge, type BridgeResponse } from "./bridge";
import { BootView, bootActions, type Environment } from "./boot/BootView";
import "./index.css";

let sessionChanged = () => {};
// The capability grants no `unlisten`, so the bridge must exist once for the page life, outside React.
const bridge = createBridge(() => sessionChanged());
const load = () => ({
  environment: bridge.getEnvironment(),
  hasSession: bridge.currentSession().then((response) => response.state === "succeeded"),
});
const firstLoad = load();

function App() {
  const [view, setView] = useState(firstLoad);
  const reload = () => setView(load());
  useEffect(() => {
    sessionChanged = reload;
  }, []);
  return (
    <Suspense fallback={<BootView state="loading" />}>
      <Boot view={view} reload={reload} />
    </Suspense>
  );
}

function Boot({ view, reload }: { view: { environment: Promise<BridgeResponse>; hasSession: Promise<boolean> }; reload: () => void }) {
  const result = use(view.environment);
  const session = use(view.hasSession);
  if (result.state !== "succeeded") return <BootView state="unavailable" code={result.code ?? result.state} session={session} />;
  return <BootView state="facts" environment={result.result as Environment} {...bootActions(bridge, reload)} />;
}

createRoot(document.getElementById("root")!).render(<App />);
