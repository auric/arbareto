// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Suspense, use, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBridge, type BridgeResponse } from "./bridge";
import { BootView, type Environment } from "./boot/BootView";

// The capability grants no `unlisten`, so the bridge must exist once for the page life, outside React.
const bridge = createBridge(invoke, listen);
const firstEnvironment = bridge.getEnvironment();

function App() {
  const [environment, setEnvironment] = useState(firstEnvironment);
  const reload = () => setEnvironment(bridge.getEnvironment());
  return (
    <Suspense fallback={<BootView state="loading" />}>
      <Boot response={environment} reload={reload} />
    </Suspense>
  );
}

function Boot({ response, reload }: { response: Promise<BridgeResponse>; reload: () => void }) {
  const result = use(response);
  if (result.state !== "succeeded") return <BootView state="unavailable" code={result.code ?? result.state} />;
  return (
    <BootView
      state="facts"
      environment={result.result as Environment}
      onSelectGit={() => void bridge.chooseGit().then(reload)}
      onDismissMarker={(markerId) => void bridge.dismissRecoveryMarker({ markerId }).then(reload)}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
